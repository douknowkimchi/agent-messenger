import { describe, expect, it } from 'bun:test'

import { parseAttachmentJson } from './client'

// A reply's src_logId above 2^53 written as a bare JSON number.
const LOG_ID = '3306475843916627969'

describe('parseAttachmentJson reply source id', () => {
  it('keeps the exact digits JSON.parse would round', () => {
    expect(String(JSON.parse(`{"src_logId":${LOG_ID}}`).src_logId)).not.toBe(LOG_ID)
    const parsed = parseAttachmentJson(
      `{"attach_only":false,"src_logId":${LOG_ID},"src_userId":42,"src_message":"원문","src_type":1,"src_mentions":[],"mentions":[]}`,
    )
    expect(parsed?.src_logId).toBe(LOG_ID)
    expect(parsed?.src_userId).toBe(42)
    expect(parsed?.src_message).toBe('원문')
  })

  it('leaves a string id and a safe number as they were', () => {
    expect(parseAttachmentJson(`{"src_logId":"${LOG_ID}"}`)?.src_logId).toBe(LOG_ID)
    expect(parseAttachmentJson('{"src_logId":42}')?.src_logId).toBe(42)
  })

  it('does not guess when the raw text is ambiguous', () => {
    // Two members (a nested one too): the rounded value stays, never a pick.
    const twice = parseAttachmentJson(`{"src_logId":${LOG_ID},"x":{"src_logId":${LOG_ID}}}`)
    expect(typeof twice?.src_logId).toBe('number')
    // A value in a string elsewhere does not count as the member.
    const quoted = parseAttachmentJson(`{"note":"\\"src_logId\\":1","src_logId":${LOG_ID}}`)
    expect(quoted?.src_logId).toBe(LOG_ID)
  })

  it('keeps malformed input closed', () => {
    expect(parseAttachmentJson('')).toBeNull()
    expect(parseAttachmentJson('[1]')).toBeNull()
    expect(parseAttachmentJson('{')).toBeNull()
  })
})

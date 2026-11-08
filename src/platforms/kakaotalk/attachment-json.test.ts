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

  it('preserves separate top-level and nested ids without scanning string contents', () => {
    // A nested member is a distinct value, not an ambiguous match.
    const twice = parseAttachmentJson(`{"src_logId":${LOG_ID},"x":{"src_logId":${LOG_ID}}}`)
    expect(twice?.src_logId).toBe(LOG_ID)
    expect(twice?.x).toEqual({ src_logId: LOG_ID })
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


describe('parseAttachmentJson exact integer contract', () => {
  it('keeps escaped keys, distinct nested ids, large authors and negative array values exact', () => {
    const next = '3306475843916627970'
    expect(parseAttachmentJson(
      `{"src_log\\u0049d":${LOG_ID},"src_userId":7467363552057858123,"x":{"src_logId":${next}},"ids":[-9110477831976617123,42]}`,
    )).toEqual({ src_logId: LOG_ID, src_userId: '7467363552057858123', x: { src_logId: next }, ids: ['-9110477831976617123', 42] })
  })

  it('keeps JSON last-member semantics and does not change quoted text or floating tokens', () => {
    const text = `quoted "src_logId":${LOG_ID} \\ end`
    expect(parseAttachmentJson(
      `{"src_logId":${LOG_ID},"src_logId":42,"text":${JSON.stringify(text)},"float":1.5,"exp":1e3,"negative":-3}`,
    )).toEqual({ src_logId: 42, text, float: 1.5, exp: 1000, negative: -3 })
  })

  it('preserves integer digits without replacing field-specific signed or unsigned validators', () => {
    expect(parseAttachmentJson('{"signed":-9223372036854775808,"unsigned":18446744073709551615,"beyond":18446744073709551616}'))
      .toEqual({ signed: '-9223372036854775808', unsigned: '18446744073709551615', beyond: '18446744073709551616' })
  })

  for (const raw of [undefined, null, 42, {}, '', '{}', 'null', 'true', '42', '[]', '[1]', '{',
    '{9007199254740993:1}', '{-9007199254740993 :1}', '{"x":{9007199254740993\n:1}}',
    '{"x":01}', '{"x":9007199254740993,}', '{"x":9007199254740993 2}', '{"x":"unterminated}',
  ]) {
    it(`rejects non-object, empty or malformed attachment: ${JSON.stringify(raw)}`, () => {
      expect(parseAttachmentJson(raw)).toBeNull()
    })
  }
})

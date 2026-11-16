import { describe, expect, it } from 'bun:test'

import { extractReadWatermarks } from './read-status'

// Ported with read-status.ts from agent-messenger (dc21ed69; MIT).
describe('extractReadWatermarks', () => {
  it('pairs CHATONROOM member ids with their watermarks', () => {
    const body = {
      a: [{ low: 7, high: 0 }, 9],
      w: [
        { low: 100, high: 0 },
        { low: 0, high: 1 },
      ],
    }
    expect(extractReadWatermarks(body, '55')).toEqual({
      chat_id: '55',
      watermarks: [
        { user_id: '7', watermark: '100' },
        { user_id: '9', watermark: '4294967296' },
      ],
    })
  })

  it('does not treat the mi member list as watermark keys', () => {
    expect(() => extractReadWatermarks({ mi: [1], w: [5] }, '1')).toThrow('read watermarks unavailable')
  })

  it('names the keys of a repeat-call response that omits a/w', () => {
    expect(() => extractReadWatermarks({ c: 1, m: [], l: 2 }, '1')).toThrow('(keys: c,m,l)')
  })

  it('throws when watermarks are missing or misaligned', () => {
    expect(() => extractReadWatermarks({ a: [1, 2] }, '1')).toThrow('read watermarks unavailable')
    expect(() => extractReadWatermarks({ a: [1, 2], w: [3] }, '1')).toThrow('read watermarks unavailable')
  })
})

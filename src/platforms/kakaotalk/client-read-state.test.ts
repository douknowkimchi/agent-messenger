// Focused client regressions runnable without Bun:
// node --import tsx --test src/platforms/kakaotalk/client-read-state.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Long } from 'bson'

import { KakaoTalkClient, KakaoTalkError } from './client'
import type { KakaoChatReadState } from './index'
import type { LocoPacket } from './protocol/types'

const ROOM = '9007199254740993'
const LOG = '18446744073709551615'
const LINK = '9223372036854775808'

function packet(body: Record<string, unknown> = {}, statusCode = 0): LocoPacket {
  return { packetId: 1, statusCode, method: '', bodyType: 0, body }
}

// Only the acquisition/transport boundary is synthetic. Public client methods,
// parsers, same-room extraction and error classification are production code.
function fixture(info: Record<string, unknown> = {}) {
  const client = new KakaoTalkClient({ connectionAdmission: () => false })
  const writes: Array<[Long, Long, Long | undefined]> = []
  const reads: Long[] = []
  let acquisitions = 0
  let replacementWrites = 0
  let onWrite = async (): Promise<LocoPacket> => packet({ status: 0 })
  let onRead = async (): Promise<LocoPacket> =>
    packet({
      chatInfo: { chatId: ROOM, type: 'OM', lastLogId: LOG, ...info },
    })
  const session = {
    getChannelInfo: async (id: Long) => {
      reads.push(id)
      return onRead()
    },
    markRead: async (chat: Long, log: Long, link?: Long) => {
      writes.push([chat, log, link])
      return onWrite()
    },
    close: () => {},
  }
  const replacement = {
    ...session,
    markRead: async () => {
      replacementWrites++
      return packet({ status: 0 })
    },
  }
  const state = { session, loginResult: {} }
  Object.assign(client, {
    state,
    ensureSession: async () => {
      acquisitions++
      return state
    },
  })
  return {
    client,
    writes,
    reads,
    counts: () => ({ acquisitions, replacementWrites }),
    setWrite: (fn: typeof onWrite) => {
      onWrite = fn
    },
    setRead: (fn: typeof onRead) => {
      onRead = fn
    },
    replace: () => {
      Object.assign(state, { session: replacement })
      Object.assign(client, { state })
    },
  }
}

test('read state preserves uint64 precision and room li, without reading content/name/profile fields', async () => {
  const f = fixture({
    chatId: Long.fromString(ROOM),
    lastLogId: Long.fromString(LOG, true),
    lastSeenLogId: Long.ZERO,
    li: Long.fromString(LINK, true),
    invalidNewMessageCount: false,
    newMessageCount: 0,
  })
  const body = {
    chatInfo: {
      chatId: Long.fromString(ROOM),
      type: 'OM',
      lastLogId: Long.fromString(LOG, true),
      lastSeenLogId: Long.ZERO,
      li: Long.fromString(LINK, true),
      invalidNewMessageCount: false,
      newMessageCount: 0,
      get displayMembers() {
        throw new Error('member/profile read forbidden')
      },
      get lastChatLog() {
        throw new Error('message read forbidden')
      },
      get chatMetas() {
        throw new Error('name read forbidden')
      },
    },
  }
  f.setRead(async () => packet(body))
  const result: KakaoChatReadState = await f.client.getChatReadState(ROOM)
  assert.deepEqual(result, {
    chat_id: ROOM,
    type: 'OM',
    last_message_id: LOG,
    last_read_message_id: '0',
    link_id: LINK,
    unread_count: 0,
  })
  assert.equal(f.reads[0].toUnsigned().toString(), ROOM)
  assert.equal(f.reads.length, 1)
  assert.equal(f.writes.length, 0)
  assert.deepEqual(f.counts(), { acquisitions: 1, replacementWrites: 0 })
  f.client.close()
})

test('read state rejects mismatch, missing/malformed/unsafe room, left room and invalid type', async () => {
  for (const info of [
    { chatId: '2' },
    { chatId: undefined },
    { chatId: Number(ROOM) },
    { chatId: '0' + ROOM },
    { chatId: { high: 0x100000000, low: 1 } },
    { left: true },
    { left: 'false' },
    { type: undefined },
    { type: -1 },
    { type: 1.5 },
    { type: Number.MAX_SAFE_INTEGER + 1 },
    { type: ' ' },
  ]) {
    const f = fixture(info)
    await assert.rejects(f.client.getChatReadState(ROOM), { code: 'get_chat_read_state_failed' })
    assert.equal(f.reads.length, 1)
    assert.equal(f.writes.length, 0)
    f.client.close()
  }
})

test('unread is known only for explicit valid flag and non-negative safe integer', async () => {
  for (const [flag, count, expected] of [
    [false, 3, 3],
    [false, 0, 0],
    [true, 0, null],
    [undefined, 0, null],
    [null, 0, null],
    [0, 0, null],
    ['false', 0, null],
    [false, undefined, null],
    [false, -1, null],
    [false, 1.5, null],
    [false, NaN, null],
    [false, Number.MAX_SAFE_INTEGER + 1, null],
    [false, '0', null],
  ]) {
    const f = fixture({ invalidNewMessageCount: flag, newMessageCount: count })
    assert.equal((await f.client.getChatReadState(ROOM)).unread_count, expected)
    f.client.close()
  }
})

test('absent and unusable watermarks stay null; zero remains zero and never falls back to lastChatLog', async () => {
  for (const value of [
    undefined,
    null,
    '',
    '-1',
    '01',
    '0x10',
    '18446744073709551616',
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    { high: 0, low: 1.5 },
    { high: NaN, low: 1 },
  ]) {
    const f = fixture({ lastLogId: value, lastSeenLogId: value, lastChatLog: { logId: '99' } })
    const result = await f.client.getChatReadState(ROOM)
    assert.equal(result.last_message_id, null)
    assert.equal(result.last_read_message_id, null)
    f.client.close()
  }
  const f = fixture({ lastLogId: 0, lastSeenLogId: LOG })
  const result = await f.client.getChatReadState(ROOM)
  assert.equal(result.last_message_id, '0')
  assert.equal(result.last_read_message_id, LOG)
  f.client.close()
})

test('link comes only from room li for an open type; member pli is never a fallback', async () => {
  for (const [type, li, expected] of [
    ['OM', LINK, LINK],
    [2, LINK, LINK],
    ['DirectChat', LINK, null],
    ['OM', undefined, null],
    ['OM', '0', null],
    ['OM', '01', null],
    ['OM', Number(ROOM), null],
  ]) {
    const f = fixture({ type, li, displayMembers: [{ pli: '123' }] })
    assert.equal((await f.client.getChatReadState(ROOM)).link_id, expected)
    f.client.close()
  }
})

test('all write IDs and read input reject noncanonical, zero, negative, overflow and runtime nonstrings before acquisition', async () => {
  for (const value of [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '01',
    '1.0',
    '1e3',
    '0x10',
    '18446744073709551616',
    null,
    undefined,
    1,
  ]) {
    const f = fixture()
    const id = value as string
    await assert.rejects(f.client.getChatReadState(id), { code: 'invalid_chat_id' })
    await assert.rejects(f.client.markReadOnce(id, '1'), { code: 'invalid_chat_id' })
    await assert.rejects(f.client.markReadOnce('1', id), { code: 'invalid_log_id' })
    if (value !== undefined) {
      await assert.rejects(f.client.markReadOnce('1', '1', { linkId: id }), { code: 'invalid_link_id' })
    }
    assert.equal(f.counts().acquisitions, 0)
    assert.equal(f.writes.length, 0)
    f.client.close()
  }
})

test('markReadOnce dispatches precise uint64 inputs once; result echoes only input', async () => {
  const f = fixture()
  assert.deepEqual(await f.client.markReadOnce(ROOM, LOG, { linkId: LINK }), {
    success: true,
    status_code: 0,
    chat_id: ROOM,
    watermark: LOG,
  })
  assert.deepEqual(
    f.writes[0].map((v) => v?.toUnsigned().toString()),
    [ROOM, LOG, LINK],
  )
  assert.equal(f.writes.length, 1)
  assert.equal(f.reads.length, 0)
  assert.equal(f.counts().acquisitions, 1)
  f.client.close()
})

test('normal chat omits link and explicit body rejection is returned, not accepted or retried', async () => {
  const f = fixture()
  f.setWrite(async () => packet({ status: -500 }))
  assert.deepEqual(await f.client.markReadOnce('1', '2'), {
    success: false,
    status_code: -500,
    chat_id: '1',
    watermark: '2',
  })
  assert.equal(f.writes[0][2], undefined)
  assert.equal(f.writes.length, 1)
  assert.equal(f.counts().acquisitions, 1)
  f.client.close()
})

test('missing/malformed ack and header failure are unknown, never accepted', async () => {
  const responses = [
    ...[undefined, null, '0', false, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((status) =>
      packet({ status }),
    ),
    packet({}),
    packet({ status: 0 }, -1),
    packet({ status: 0 }, 403),
    { ...packet({ status: 0 }), statusCode: undefined as unknown as number },
  ]
  for (const response of responses) {
    const f = fixture()
    f.setWrite(async () => response)
    await assert.rejects(f.client.markReadOnce('1', '2'), {
      code: 'mark_read_unknown',
      responseFailureKind: 'transient_or_unknown',
    })
    assert.equal(f.writes.length, 1)
    assert.equal(f.counts().acquisitions, 1)
    f.client.close()
  }
})

test('in-flight session replacement or client close cannot cause another dispatch', async () => {
  for (const mode of ['replacement', 'close'] as const) {
    const f = fixture()
    const cause = new Error('synthetic socket closed after dispatch')
    f.setWrite(async () => {
      if (mode === 'close') f.client.close()
      f.replace()
      throw cause
    })
    await assert.rejects(f.client.markReadOnce('1', '2'), (error: unknown) => {
      assert.ok(error instanceof KakaoTalkError)
      assert.equal(error.code, 'mark_read_unknown')
      assert.equal(error.responseFailureKind, 'transient_or_unknown')
      assert.equal(error.cause, cause)
      return true
    })
    assert.equal(f.writes.length, 1)
    assert.deepEqual(f.counts(), { acquisitions: 1, replacementWrites: 0 })
    f.client.close()
  }
})

test('CHATINFO provider/transport failures do not return a state', async () => {
  for (const response of [packet({}, 403), packet({ status: -404 }), packet({}, -1), packet({})]) {
    const f = fixture()
    f.setRead(async () => response)
    await assert.rejects(f.client.getChatReadState(ROOM), { code: 'get_chat_read_state_failed' })
    assert.equal(f.reads.length, 1)
    assert.equal(f.writes.length, 0)
    f.client.close()
  }
})

test('legacy markRead still accepts missing body status', async () => {
  const f = fixture()
  f.setWrite(async () => packet({}))
  assert.equal((await f.client.markRead('1', '2')).success, true)
  assert.equal(f.writes.length, 1)
  f.client.close()
})

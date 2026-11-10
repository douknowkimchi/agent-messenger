// Focused client regressions runnable without Bun:
// node --import tsx --test src/platforms/kakaotalk/client-read-state.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Long } from 'bson'

import { KakaoTalkClient, KakaoTalkError } from './client'
import type { KakaoChatReadState } from './index'
import type { LocoPacket } from './protocol/types'
import { LocoSession } from './protocol/session'

const ROOM = '9007199254740993'
const LOG = '18446744073709551615'
const LINK = '9223372036854775808'

test('one-shot read state uses the ready session without acquisition or writes', async () => {
  for (const [type, direct, link] of [
    ['DirectChat', null, null], ['MultiChat', null, null], ['OD', true, LINK], ['OM', false, LINK],
  ] as const) {
    const f = fixture({ type, directChat: direct, li: link, invalidNewMessageCount: false, newMessageCount: 3 })
    const value = await f.client.getChatReadStateOnce(ROOM)
    assert.equal(value.chat_id, ROOM)
    assert.equal(value.type, type)
    assert.equal(value.link_id, link)
    assert.equal(value.unread_count, 3)
    assert.equal(f.reads[0].toUnsigned().toString(), ROOM)
    assert.equal(f.reads.length, 1)
    assert.equal(f.writes.length, 0)
    assert.equal(f.counts().acquisitions, 0)
    f.client.close()
  }
})

for (const unavailable of ['missing', 'closed']) test(`one-shot read state refuses ${unavailable} session without login`, async () => {
  const f = fixture()
  Object.assign(f.client, unavailable === 'missing' ? { state: null } : { closed: true })
  await assert.rejects(f.client.getChatReadStateOnce(ROOM), { code: 'get_chat_read_state_not_dispatched' })
  assert.equal(f.reads.length, 0)
  assert.equal(f.counts().acquisitions, 0)
  f.client.close()
})

test('one-shot read state refuses cancellation before dispatch', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort()
  await assert.rejects(f.client.getChatReadStateOnce(ROOM, { signal: controller.signal }))
  assert.equal(f.reads.length, 0); assert.equal(f.counts().acquisitions, 0)
  f.client.close()
})

for (const failure of ['replace', 'close', 'cancel', 'loss']) test(`one-shot read state rejects ${failure} after one dispatch without replay`, async () => {
  const f = fixture(); const controller = new AbortController()
  f.setRead(async () => {
    if (failure === 'replace') f.replace()
    if (failure === 'close') f.client.close()
    if (failure === 'cancel') controller.abort()
    if (failure === 'loss') throw new Error('synthetic lost response')
    return packet({ chatInfo: { chatId: ROOM, type: 'OM', lastLogId: LOG, li: LINK } })
  })
  await assert.rejects(f.client.getChatReadStateOnce(ROOM, { signal: controller.signal }), { code: 'get_chat_read_state_failed' })
  assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 0)
  assert.equal(f.counts().acquisitions, 0)
  f.client.close()
})

test('one-shot read state rejects invalid IDs before dispatch', async () => {
  const f = fixture()
  for (const id of ['0', '01', '-1', '18446744073709551616', '1e3']) {
    await assert.rejects(f.client.getChatReadStateOnce(id))
  }
  assert.equal(f.reads.length, 0); assert.equal(f.counts().acquisitions, 0)
  f.client.close()
})

test('one-shot read state shares strict response validation with the legacy reader', async () => {
  for (const response of [packet({ chatInfo: { chatId: '2', type: 'OM' } }), packet({}, -1), packet({})]) {
    const f = fixture(); f.setRead(async () => response)
    await assert.rejects(f.client.getChatReadStateOnce(ROOM), { code: 'get_chat_read_state_failed' })
    assert.equal(f.reads.length, 1); assert.equal(f.counts().acquisitions, 0)
    f.client.close()
  }
})

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
    open_direct: null,
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

// History shares the existing session/acquisition owner, but may not replay a
// potentially applied SYNCMSG. No login, socket, provider or persisted state.
function historyFixture() {
  const client = new KakaoTalkClient({ connectionAdmission: () => false })
  const calls: Array<{ method: string; args: unknown[]; replacement: boolean }> = []
  let acquisitions = 0
  const row = (id: unknown, chatId: unknown = 100): Record<string, unknown> => ({
    chatId, logId: id, type: 1, authorId: 1, message: 'synthetic', sendAt: 1,
  })
  let mchat = async (): Promise<LocoPacket> => packet({ status: 0, chatLogs: [], eof: true })
  let info = async (): Promise<LocoPacket> => packet({ status: 0, chatInfo: { chatId: 100, lastLogId: 13 } })
  let sync = async (): Promise<LocoPacket> => packet({ status: 0, chatLogs: [row(11), row(12), row(13)], isOK: false })
  const makeSession = (replacement: boolean) => ({
    getChatLogs: async (...args: unknown[]) => { calls.push({ method: 'MCHATLOGS', args, replacement }); return mchat() },
    getChannelInfo: async (...args: unknown[]) => { calls.push({ method: 'CHATINFO', args, replacement }); return info() },
    syncMessages: async (...args: unknown[]) => { calls.push({ method: 'SYNCMSG', args, replacement }); return sync() },
    close() {},
  })
  const session = makeSession(false)
  const replacement = makeSession(true)
  const state = { session, loginResult: { chatDatas: [] } }
  Object.assign(client, {
    state,
    ensureSession: async () => { acquisitions++; return (client as unknown as { state: typeof state }).state },
  })
  const run = (kind: 'recent' | 'page', count = 20, from = '10') => kind === 'recent'
    ? client.getMessages('100', { count, from }) : client.getMessagePage('100', { count, from })
  return {
    client, row, calls, run, acquisitions: () => acquisitions,
    setMchat: (fn: typeof mchat) => { mchat = fn },
    setInfo: (fn: typeof info) => { info = fn },
    setSync: (fn: typeof sync) => { sync = fn },
    replace: () => Object.assign(client, { state: { ...state, session: replacement } }),
  }
}

for (const kind of ['recent', 'page'] as const) {
  for (const count of [1, 20, 100]) {
    test(`history repair ${kind} return count ${count} never becomes held-count`, async () => {
      const f = historyFixture()
      try {
        const rows = Array.from({ length: 105 }, (_, n) => f.row(11 + n))
        f.setInfo(async () => packet({ status: 0, chatInfo: { chatId: 100, lastLogId: 115 } }))
        f.setSync(async () => packet({ status: 0, chatLogs: rows, isOK: false }))
        const value = await f.run(kind, count)
        const messages = Array.isArray(value) ? value : value.messages
        assert.equal(messages.length, count)
        assert.equal(messages[0]!.log_id, String(kind === 'recent' ? 116 - count : 11))
        assert.equal(messages.at(-1)!.log_id, String(kind === 'recent' ? 115 : 10 + count))
        assert.deepEqual(f.calls.filter(c => c.method === 'SYNCMSG').map(c => c.args.map(String)), [['100', '0', '10', '115']])
        assert.equal(f.acquisitions(), 1)
      } finally { f.client.close() }
    })
  }

  for (const shape of ['missing', 'null', 'array'] as const) {
    for (const isOK of [false, true]) {
      test(`history repair ${kind} successful ${shape} isOK=${isOK} ${kind === 'page' && isOK ? 'ends the forward interval' : 'stays unmet'}`, async () => {
        const f = historyFixture()
        try {
          f.setSync(async () => packet({ status: 0, isOK, ...(shape === 'missing' ? {} : { chatLogs: shape === 'null' ? null : [] }) }))
          if (kind === 'recent') {
            await assert.rejects(f.run(kind), (e: unknown) => {
              const error = e as Error & { code: string; cause: Error }
              assert.equal(error.code, 'get_messages_failed')
              assert.equal(error.cause.message, 'message_history_unavailable')
              return true
            })
          } else {
            // The forward page follows SDK18/KiwiTalk: isOK ends the interval
            // even before CHATINFO's lastLogId; without isOK it stays open.
            assert.deepEqual(await f.run(kind), { messages: [], next_cursor: null, complete: isOK })
          }
          assert.equal(f.calls.filter(c => c.method === 'SYNCMSG').length, 1)
        } finally { f.client.close() }
      })
    }
  }

  for (const invalid of [{}, 'logs', 0, false]) {
    test(`history repair ${kind} rejects non-array collection ${JSON.stringify(invalid)}`, async () => {
      const f = historyFixture()
      try {
        f.setSync(async () => packet({ status: 0, chatLogs: invalid, isOK: false }))
        await assert.rejects(f.run(kind), (e: unknown) => {
          assert.equal((e as Error & { cause: Error }).cause.message, 'message_history_invalid')
          return true
        })
      } finally { f.client.close() }
    })
  }

  for (const boundary of ['acquired', 'mchat-error', 'mchat-empty', 'mchat-terminal', 'mchat-next', 'info-zero', 'info-positive', 'sync-error', 'sync-next', 'sync-terminal', 'sync-close'] as const) {
    test(`history repair ${kind} ${boundary} replacement blocks replay, fallback, next page and stale success`, async () => {
      const f = historyFixture()
      try {
        if (boundary === 'acquired') {
          Object.assign(f.client, { acquireSession: async () => {
            const session = (f.client as unknown as { state: { session: unknown } }).state.session
            f.replace()
            return session
          } })
        } else if (boundary.startsWith('mchat')) {
          f.setMchat(async () => {
            f.replace()
            if (boundary === 'mchat-error') throw new Error('synthetic lost response')
            return packet({ status: 0, chatLogs: boundary === 'mchat-empty' ? [] : [f.row(11)], eof: boundary === 'mchat-terminal' })
          })
        } else if (boundary.startsWith('info')) {
          f.setInfo(async () => {
            f.replace()
            return packet({ status: 0, chatInfo: { chatId: 100, lastLogId: boundary === 'info-zero' ? 0 : 13 } })
          })
        } else {
          f.setSync(async () => {
            if (boundary === 'sync-close') f.client.close()
            else f.replace()
            if (boundary === 'sync-error') throw new Error('synthetic lost response')
            return packet({ status: 0, chatLogs: [f.row(boundary === 'sync-next' ? 11 : 13)], isOK: boundary !== 'sync-next' })
          })
        }
        await assert.rejects(f.run(kind), { code: kind === 'recent' ? 'get_messages_failed' : 'get_message_page_failed' })
        assert.equal(f.calls.some(c => c.replacement), false)
        assert.ok(f.acquisitions() <= 1)
        assert.deepEqual(f.calls.map(c => c.method), boundary === 'acquired' ? [] : boundary.startsWith('mchat') ? ['MCHATLOGS'] : boundary.startsWith('info') ? ['MCHATLOGS', 'CHATINFO'] : ['MCHATLOGS', 'CHATINFO', 'SYNCMSG'])
      } finally { f.client.close() }
    })
  }

  test(`history repair ${kind} same-session lost SYNCMSG is not retried`, async () => {
    const f = historyFixture()
    try {
      f.setSync(async () => { throw new Error('synthetic lost response') })
      await assert.rejects(f.run(kind))
      assert.equal(f.acquisitions(), 1)
      assert.equal(f.calls.filter(c => c.method === 'SYNCMSG').length, 1)
    } finally { f.client.close() }
  })

  for (const from of ['13', '14']) {
    test(`history repair ${kind} cursor ${from} at or beyond fresh max sends no SYNCMSG`, async () => {
      const f = historyFixture()
      try {
        const result = await f.run(kind, 20, from)
        assert.deepEqual(result, kind === 'recent' ? [] : { messages: [], next_cursor: null, complete: true })
        assert.equal(f.calls.some(c => c.method === 'SYNCMSG'), false)
      } finally { f.client.close() }
    })
  }
}

for (const id of [13, Long.fromNumber(13), Long.fromString('9007199254740993')]) {
  test(`history repair exact max ${String(id)} completes independently of BSON promotion and isOK`, async () => {
    for (const kind of ['recent', 'page'] as const) {
      const f = historyFixture()
      try {
        f.setInfo(async () => packet({ status: 0, chatInfo: { chatId: 100, lastLogId: id } }))
        f.setSync(async () => packet({ status: 0, chatLogs: [f.row(id)], isOK: false }))
        const value = await f.run(kind)
        if (Array.isArray(value)) assert.deepEqual(value.map(m => m.log_id), [String(id)])
        else { assert.equal(value.complete, true); assert.equal(value.messages[0]!.log_id, String(id)) }
      } finally { f.client.close() }
    }
  })
}

for (const id of [Number.MAX_SAFE_INTEGER + 1, 13.5, -1, '18446744073709551616', { high: 4294967296, low: 13 }]) {
  test(`history repair invalid maximum ${JSON.stringify(id)} cannot complete the interval`, async () => {
    for (const kind of ['recent', 'page'] as const) {
      const f = historyFixture()
      try {
        f.setSync(async () => packet({ status: 0, chatLogs: [f.row(id)], isOK: true }))
        await assert.rejects(f.run(kind))
      } finally { f.client.close() }
    }
  })
}

test('history repair normal forward pagination remains one operation on one session', async () => {
  const f = historyFixture()
  try {
    let next = 11
    f.setSync(async () => packet({ status: 0, chatLogs: [f.row(next++)], isOK: false }))
    const value = await f.run('recent')
    assert.deepEqual((value as Array<{ log_id: string }>).map(m => m.log_id), ['11', '12', '13'])
    assert.deepEqual(f.calls.filter(c => c.method === 'SYNCMSG').map(c => c.args.map(String)), [
      ['100', '0', '10', '13'], ['100', '0', '11', '13'], ['100', '0', '12', '13'],
    ])
    assert.equal(f.acquisitions(), 1)
    assert.equal(f.calls.some(c => c.replacement), false)
  } finally { f.client.close() }
})

// The real provider shape that rejected every SDK22 startup reconciliation
// read (STARTUP:sdk:message_history_incomplete x55): an empty MCHATLOGS from the
// persisted cursor, a CHATINFO lastLogId beyond it, and a SYNCMSG that ends the
// interval with isOK before that target. The forward page returns what was
// sent and ends; the recent reader still refuses to call it a current suffix.
for (const rows of [[], [11], [11, 12]]) {
  test(`forward page accepts isOK before the CHATINFO target with ${rows.length} record(s); recent stays strict`, async () => {
    const page = historyFixture()
    try {
      page.setSync(async () => packet({ status: 0, chatLogs: rows.map(id => page.row(id)), isOK: true }))
      const value = await page.run('page')
      assert.equal(Array.isArray(value), false)
      const result = value as { messages: Array<{ log_id: string }>; complete: boolean }
      assert.deepEqual(result.messages.map(m => m.log_id), rows.map(String))
      assert.equal(result.complete, true)
      assert.deepEqual(page.calls.map(c => c.method), ['MCHATLOGS', 'CHATINFO', 'SYNCMSG'])
      assert.deepEqual(page.calls.filter(c => c.method === 'SYNCMSG').map(c => c.args.map(String)), [['100', '0', '10', '13']])
      assert.equal(page.acquisitions(), 1)
    } finally { page.client.close() }

    const recent = historyFixture()
    try {
      recent.setSync(async () => packet({ status: 0, chatLogs: rows.map(id => recent.row(id)), isOK: true }))
      await assert.rejects(recent.run('recent'), (e: unknown) => {
        const error = e as Error & { code: string; cause: Error }
        assert.equal(error.code, 'get_messages_failed')
        assert.equal(error.cause.message, rows.length === 0 ? 'message_history_unavailable' : 'message_history_incomplete')
        return true
      })
      assert.equal(recent.calls.filter(c => c.method === 'SYNCMSG').length, 1)
    } finally { recent.client.close() }
  })
}

// Existing open-room identity needs no new login or alternate protocol stack.
function openIdentityFixture(faultAt = 0, fault = '', type: string | number = 'OD') {
  const client = new KakaoTalkClient({ connectionAdmission: () => false })
  const controller = new AbortController()
  const calls: string[] = []
  const members = [{ userId: Long.ONE, nickName: 'self' }, { userId: Long.fromInt(2), nickName: 'peer' }]
  const info = { chatId: ROOM, type, directChat: type === 'OD', li: 300, lastLogId: LOG,
    activeMembersCount: 2, displayMembers: members, invalidNewMessageCount: false, newMessageCount: 3 }
  let acquisitions = 0
  const reply = async (method: string, value: Record<string, unknown>) => {
    calls.push(method)
    if (calls.length === faultAt) {
      if (fault === 'loss') throw new Error('synthetic loss')
      if (fault === 'replace') Object.assign(client, { state: { session: { close: () => {} }, loginResult: {} } })
      if (fault === 'same-state-replace') state.session = new LocoSession()
      if (fault === 'close') client.close()
      if (fault === 'cancel') controller.abort()
    }
    return packet(value)
  }
  const session = new LocoSession()
  Object.assign(session, { connection: {
    sendPacket: async (method: string, body: Record<string, unknown>) => {
      if (method === 'INFOLINK') {
        assert.deepEqual(Object.keys(body), ['lis'])
        assert.deepEqual((body.lis as Long[]).map(x => x.toString()), ['300'])
        return reply(method, { ols: [{ li: '300', lt: 1, ac: true, ln: 'synthetic', olu: { userId: Long.fromInt(2) } }] })
      }
      assert.ok(['CHATINFO', 'GETMEM'].includes(method), 'no login, JOIN or read mark')
      assert.deepEqual(Object.keys(body), ['chatId'])
      assert.equal((body.chatId as Long).toUnsigned().toString(), ROOM)
      return reply(method, method === 'CHATINFO' ? { chatInfo: info } : { members })
    }, close() {},
  } })
  const state = { session, loginResult: {} }
  Object.assign(client, { state, ensureSession: async () => { acquisitions++; throw new Error('acquisition forbidden') } })
  return { client, calls, controller, info, acquisitions: () => acquisitions }
}

for (const type of ['OD', 'OM', 2]) test(`bounded open identity ${type} shares existing parsers in at most eight packets`, async () => {
  const f = openIdentityFixture(0, '', type)
  const result = await f.client.getOpenRoomIdentityOnce(ROOM, '300')
  assert.equal(result.read_state.chat_id, ROOM)
  assert.equal(result.chat.chat_id, ROOM)
  assert.equal(result.members.complete, true)
  assert.equal(result.members.members.length, 2)
  assert.equal(result.link.owner_user_id, '2')
  assert.deepEqual(f.calls, ['CHATINFO', 'CHATINFO', 'INFOLINK', 'CHATINFO', 'GETMEM', 'CHATINFO', 'GETMEM', 'INFOLINK'])
  assert.equal(f.acquisitions(), 0)
  f.client.close()
})

for (const fault of ['loss', 'replace', 'same-state-replace', 'close', 'cancel']) {
  for (let at = 1; at <= 8; at++) test(`bounded open identity stops after packet ${at} on ${fault}`, async () => {
    const f = openIdentityFixture(at, fault)
    await assert.rejects(f.client.getOpenRoomIdentityOnce(ROOM, '300', { signal: f.controller.signal }))
    assert.equal(f.calls.length, at)
    assert.equal(f.acquisitions(), 0)
    f.client.close()
  })
}

test('bounded open identity refuses invalid IDs, missing session and pre-cancel before dispatch', async () => {
  for (const mode of ['bad-chat', 'bad-link', 'missing', 'cancel']) {
    const f = openIdentityFixture()
    if (mode === 'missing') Object.assign(f.client, { state: null })
    if (mode === 'cancel') f.controller.abort()
    await assert.rejects(f.client.getOpenRoomIdentityOnce(mode === 'bad-chat' ? '01' : ROOM,
      mode === 'bad-link' ? '0' : '300', { signal: f.controller.signal }))
    assert.equal(f.calls.length, 0); assert.equal(f.acquisitions(), 0)
    f.client.close()
  }
})

test('bounded open identity refuses a different link before follow-up lookups', async () => {
  const f = openIdentityFixture(); f.info.li = 301
  await assert.rejects(f.client.getOpenRoomIdentityOnce(ROOM, '300'))
  assert.deepEqual(f.calls, ['CHATINFO']); assert.equal(f.acquisitions(), 0)
  f.client.close()
})

// Recent room opening is deliberately separate from legacy history repair.
function readOnlyRecentFixture(mode: string) {
  const client = new KakaoTalkClient({ connectionAdmission: () => { throw new Error('login prohibited') } })
  const session = new LocoSession(), calls: string[] = [], controller = new AbortController()
  const state = { session, loginResult: {} }
  Object.assign(client, { state, acquireSession: async () => { throw new Error('acquire prohibited') } })
  Object.assign(session, { connection: { close() {}, sendPacket: async (method: string) => {
    calls.push(method)
    assert.equal(method, 'MCHATLOGS', 'recent opening cannot send SYNCMSG/NOTIREAD/CHATONROOM')
    if (mode === 'loss') throw new Error('synthetic response lost')
    if (mode === 'replace') Object.assign(client, { state: { session: new LocoSession(), loginResult: {} } })
    if (mode === 'same-state-replace') state.session = new LocoSession()
    if (mode === 'close') client.close()
    if (mode === 'cancel') controller.abort()
    if (mode === 'empty') return packet({ chatLogs: [], eof: true })
    const id = calls.length
    return packet({ chatLogs: [{ chatId: mode === 'wrong-room' ? 200 : 100,
      logId: Long.fromInt(mode === 'stalled' ? 1 : id), type: 1, authorId: 1,
      message: 'synthetic', sendAt: id }], eof: mode === 'complete' && id === 2 })
  } } })
  return { client, calls, controller }
}

test('read-only recent opening returns a proven suffix through one captured session', async () => {
  const f = readOnlyRecentFixture('complete')
  try {
    const result = await f.client.getRecentMessagesReadOnlyOnce('100', { count: 1 })
    assert.deepEqual(result.map(m => m.log_id), ['2'])
    assert.deepEqual(f.calls, ['MCHATLOGS','MCHATLOGS'])
  } finally { f.client.close() }
})
for (const mode of ['empty','loss','replace','same-state-replace','close','cancel','wrong-room','stalled','limit']) {
  test(`read-only recent opening ${mode} fails without implicit mark, reconnect or fallback`, async () => {
    const f = readOnlyRecentFixture(mode)
    try {
      await assert.rejects(f.client.getRecentMessagesReadOnlyOnce('100', { signal: f.controller.signal }))
      assert.equal(f.calls.length, mode === 'limit' ? 4 : mode === 'stalled' ? 2 : 1)
      assert.ok(f.calls.every(method => method === 'MCHATLOGS'))
    } finally { f.client.close() }
  })
}
test('read-only recent opening validates input and cancellation before dispatch', async () => {
  const f = readOnlyRecentFixture('complete')
  try {
    for (const id of ['0','01','18446744073709551616']) await assert.rejects(f.client.getRecentMessagesReadOnlyOnce(id))
    await assert.rejects(f.client.getRecentMessagesReadOnlyOnce('100', { count: 101 }))
    f.controller.abort()
    await assert.rejects(f.client.getRecentMessagesReadOnlyOnce('100', { signal: f.controller.signal }))
    assert.equal(f.calls.length, 0)
  } finally { f.client.close() }
})
for (const method of ['getChatOnce','getMemberSnapshotOnce'] as const) {
  test(`${method} keeps the existing parser on the present session`, async () => {
    const f = openIdentityFixture(0,'','OM')
    try { await f.client[method](ROOM); assert.equal(f.calls.length, method === 'getChatOnce' ? 2 : 4); assert.equal(f.acquisitions(),0) }
    finally { f.client.close() }
  })
  for (const fault of ['loss','replace','same-state-replace','close','cancel']) test(`${method} ${fault} sends no follow-up`, async () => {
    const f = openIdentityFixture(1,fault,'OM')
    try { await assert.rejects(f.client[method](ROOM,{signal:f.controller.signal})); assert.equal(f.calls.length,1); assert.equal(f.acquisitions(),0) }
    finally { f.client.close() }
  })
}

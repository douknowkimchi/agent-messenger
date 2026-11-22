// Focused client regressions runnable without Bun:
// node --import tsx --test src/platforms/kakaotalk/client-chat-list-lookup.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Long } from 'bson'

import { KakaoTalkClient } from './client'
import type { LocoPacket } from './protocol/types'
import { LocoSession } from './protocol/session'

const ROOM = '9007199254740993'
const OTHER = '9007199254740995'

function packet(body: Record<string, unknown> = {}, statusCode = 0): LocoPacket {
  return { packetId: 1, statusCode, method: '', bodyType: 0, body }
}

function row(chatId: string, extra: Record<string, unknown> = {}) {
  return { c: Long.fromString(chatId), t: 'MultiChat', a: 3, n: 0, k: ['a', 'b'], i: [Long.fromInt(2), Long.fromInt(3)], ...extra }
}

const teamInfo = (chatId = ROOM) => ({
  chatInfo: { chatId, type: 'MultiChat', chatMetas: [{ type: 3, content: 'team-room' }, { type: 15, content: '{}' }] },
})

// Only the LOCO connection is synthetic; the public client method, session
// packet builders, status checks and chat formatting are production code.
function fixture(pages: Array<LocoPacket | (() => LocoPacket)>, chatInfo: LocoPacket = packet(teamInfo())) {
  const client = new KakaoTalkClient({ connectionAdmission: () => false })
  const controller = new AbortController()
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  let acquisitions = 0
  let onSend: ((method: string) => void) | null = null
  const session = new LocoSession()
  Object.assign(session, {
    connection: {
      sendPacket: async (method: string, body: Record<string, unknown>) => {
        calls.push({ method, body })
        onSend?.(method)
        if (method === 'LCHATLIST') {
          const next = pages[calls.filter((call) => call.method === 'LCHATLIST').length - 1]
          assert.ok(next, 'no request past the scripted pages')
          return typeof next === 'function' ? next() : next
        }
        assert.equal(method, 'CHATINFO', 'no login, JOIN, read mark or message request')
        assert.deepEqual(Object.keys(body), ['chatId'])
        return chatInfo
      },
      close() {},
    },
  })
  const state = { session, loginResult: {} }
  Object.assign(client, {
    state,
    ensureSession: async () => {
      acquisitions++
      throw new Error('acquisition forbidden')
    },
  })
  return {
    client,
    calls,
    controller,
    state,
    acquisitions: () => acquisitions,
    onSend: (fn: (method: string) => void) => {
      onSend = fn
    },
  }
}

test('finds a chat on a later page from the list start and reads its header once', async () => {
  const f = fixture([
    packet({ chatDatas: [row(OTHER)], eof: false, lastTokenId: Long.fromInt(7), lastChatId: Long.fromString(OTHER) }),
    packet({ chatDatas: [row(ROOM)], eof: true }),
  ])
  try {
    const chat = await f.client.findChatInListOnce(ROOM)
    assert.equal(chat?.chat_id, ROOM)
    assert.equal(chat?.title, 'team-room')
    assert.equal(chat?.team, true)
    assert.equal(chat?.active_members, 3)
    assert.deepEqual(f.calls.map((call) => call.method), ['LCHATLIST', 'LCHATLIST', 'CHATINFO'])
    assert.equal((f.calls[0].body.lastTokenId as Long).toString(), '0')
    assert.equal((f.calls[0].body.lastChatId as Long).toString(), '0')
    assert.equal((f.calls[1].body.lastTokenId as Long).toString(), '7')
    assert.equal((f.calls[1].body.lastChatId as Long).toString(), OTHER)
    assert.equal((f.calls[2].body.chatId as Long).toUnsigned().toString(), ROOM)
    assert.equal(f.acquisitions(), 0)
  } finally {
    f.client.close()
  }
})

test('resolves null when the whole list to EOF does not hold the chat, without CHATINFO', async () => {
  const f = fixture([packet({ chatDatas: [row(OTHER)], eof: true })])
  try {
    assert.equal(await f.client.findChatInListOnce(ROOM), null)
    assert.deepEqual(f.calls.map((call) => call.method), ['LCHATLIST'])
  } finally {
    f.client.close()
  }
})

test('a refused header read keeps the listed chat with title and team unknown', async () => {
  const f = fixture([packet({ chatDatas: [row(ROOM, { a: 2 })], eof: true })], packet({}, -401))
  try {
    const chat = await f.client.findChatInListOnce(ROOM)
    assert.equal(chat?.chat_id, ROOM)
    assert.equal(chat?.title, null)
    assert.equal('team' in (chat ?? {}), false)
    assert.equal(chat?.display_name, 'a, b')
  } finally {
    f.client.close()
  }
})

test('a list status rejection keeps the provider status and sends nothing more', async () => {
  const f = fixture([packet({}, -401)])
  try {
    await assert.rejects(f.client.findChatInListOnce(ROOM), {
      code: 'find_chat_in_list_failed',
      responseFailureKind: 'provider_rejection',
      serverStatus: -401,
    })
    assert.equal(f.calls.length, 1)
  } finally {
    f.client.close()
  }
})

for (const [name, page] of [
  ['empty non-EOF page', packet({ chatDatas: [], eof: false })],
  ['missing chatDatas', packet({ eof: true })],
  ['synthetic close', packet({ error: 'connection closed' }, -1)],
] as const) {
  test(`an incomplete list (${name}) fails instead of reporting absence`, async () => {
    const f = fixture([page])
    try {
      await assert.rejects(f.client.findChatInListOnce(ROOM), { code: 'find_chat_in_list_failed' })
      assert.equal(f.calls.length, 1)
    } finally {
      f.client.close()
    }
  })
}

test('a list longer than the page bound fails instead of reporting absence', async () => {
  const page = () => packet({ chatDatas: [row(OTHER)], eof: false, lastTokenId: Long.ONE, lastChatId: Long.fromString(OTHER) })
  const f = fixture(Array.from({ length: 50 }, () => page))
  try {
    await assert.rejects(f.client.findChatInListOnce(ROOM), { code: 'find_chat_in_list_failed' })
    assert.equal(f.calls.length, 50)
  } finally {
    f.client.close()
  }
})

for (const fault of ['loss', 'replace', 'same-state-replace', 'close', 'cancel']) {
  test(`${fault} during the list read sends no follow-up`, async () => {
    const f = fixture([
      () => {
        if (fault === 'loss') throw new Error('synthetic loss')
        return packet({ chatDatas: [row(ROOM)], eof: true })
      },
    ])
    f.onSend(() => {
      if (fault === 'replace') Object.assign(f.client, { state: { session: { close: () => {} }, loginResult: {} } })
      if (fault === 'same-state-replace') f.state.session = new LocoSession()
      if (fault === 'close') f.client.close()
      if (fault === 'cancel') f.controller.abort()
    })
    try {
      await assert.rejects(f.client.findChatInListOnce(ROOM, { signal: f.controller.signal }))
      assert.deepEqual(f.calls.map((call) => call.method), ['LCHATLIST'])
      assert.equal(f.acquisitions(), 0)
    } finally {
      f.client.close()
    }
  })
}

test('a session replaced during the header read discards the late result', async () => {
  const f = fixture([packet({ chatDatas: [row(ROOM)], eof: true })])
  f.onSend((method) => {
    if (method === 'CHATINFO') f.state.session = new LocoSession()
  })
  try {
    await assert.rejects(f.client.findChatInListOnce(ROOM), { code: 'find_chat_in_list_failed' })
    assert.deepEqual(f.calls.map((call) => call.method), ['LCHATLIST', 'CHATINFO'])
  } finally {
    f.client.close()
  }
})

test('no dispatch without a present session, after cancellation or for an invalid ID', async () => {
  const missing = fixture([])
  Object.assign(missing.client, { state: null })
  await assert.rejects(missing.client.findChatInListOnce(ROOM), { code: 'find_chat_in_list_failed' })
  const aborted = fixture([])
  aborted.controller.abort()
  await assert.rejects(aborted.client.findChatInListOnce(ROOM, { signal: aborted.controller.signal }))
  const invalid = fixture([])
  for (const id of ['0', '01', '-1', '18446744073709551616', '1e3']) {
    await assert.rejects(invalid.client.findChatInListOnce(id))
  }
  for (const f of [missing, aborted, invalid]) {
    assert.equal(f.calls.length, 0)
    assert.equal(f.acquisitions(), 0)
    f.client.close()
  }
})

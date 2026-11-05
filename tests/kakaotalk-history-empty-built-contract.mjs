import assert from 'node:assert/strict'
import test from 'node:test'
import { KakaoTalkClient } from '../dist/src/platforms/kakaotalk/client.js'

// Recent history of a room with nothing this account can read. Only the
// provider's explicit end (MCHATLOGS empty from the start, then SYNCMSG isOK
// with no record) is an empty room; every other empty answer stays a failure.
const long = n => ({ low: n, high: 0 })
const row = id => ({ chatId: long(100), logId: long(id), type: 1, authorId: long(1), message: 'synthetic', sendAt: 1 })
function fixture({ mchat = [], sync = { chatLogs: [], isOK: true }, lastLogId = 13, mchatThrows = false } = {}) {
  const calls = []
  const session = {
    async getChatLogs(...args) { calls.push(['MCHATLOGS', ...args.flat().map(String)]); if (mchatThrows) throw new Error('synthetic transport'); return { statusCode: 0, body: { status: 0, chatLogs: mchat, eof: mchat.length > 0 } } },
    async getChannelInfo() { calls.push(['CHATINFO']); return { statusCode: 0, body: { status: 0, chatInfo: { chatId: long(100), lastLogId: long(lastLogId) } } } },
    async syncMessages(...args) { calls.push(['SYNCMSG', ...args.map(String)]); return { statusCode: 0, body: { status: 0, ...sync } } },
    close() {},
  }
  const state = { session, loginResult: { chatDatas: [] } }
  const client = Object.assign(new KakaoTalkClient({ connectionAdmission: () => false }), { state, ensureSession: async () => state })
  return { client, calls }
}
const unavailable = error => error.code === 'get_messages_failed' && error.cause?.message === 'message_history_unavailable'

test('room with no readable record: provider isOK end from the start is an empty room', async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.client.getMessages('100', { count: 20 }), [])
    assert.deepEqual(f.calls.map(c => c[0]), ['MCHATLOGS', 'CHATINFO', 'SYNCMSG'])
  } finally { f.client.close() }
})

for (const [name, sync] of [['isOK false', { chatLogs: [], isOK: false }], ['isOK missing', { chatLogs: [] }],
  ['null logs without isOK', { chatLogs: null }], ['isOK as text', { chatLogs: [], isOK: 'true' }]]) {
  test(`empty SYNCMSG with ${name} stays unavailable`, async () => {
    const f = fixture({ sync })
    try { await assert.rejects(f.client.getMessages('100', { count: 20 }), unavailable) } finally { f.client.close() }
  })
}

test('a cursor never proves an empty room', async () => {
  const f = fixture()
  try { await assert.rejects(f.client.getMessages('100', { count: 20, from: '10' }), unavailable) } finally { f.client.close() }
})

test('a failed start read never proves an empty room', async () => {
  const f = fixture({ mchatThrows: true })
  try { await assert.rejects(f.client.getMessages('100', { count: 20 }), unavailable) } finally { f.client.close() }
})

test('records still read normally and the watermark proof is unchanged', async () => {
  const f = fixture({ mchat: [row(11), row(12)] })
  try { assert.deepEqual((await f.client.getMessages('100', { count: 20 })).map(m => m.log_id), ['11', '12']) } finally { f.client.close() }
  const g = fixture({ lastLogId: 0 })
  try { assert.deepEqual(await g.client.getMessages('100', { count: 20 }), []); assert.deepEqual(g.calls.map(c => c[0]), ['MCHATLOGS', 'CHATINFO']) } finally { g.client.close() }
  const h = fixture({ sync: { chatLogs: [row(11), row(12), row(13)], isOK: true } })
  try { assert.deepEqual((await h.client.getMessages('100', { count: 20 })).map(m => m.log_id), ['11', '12', '13']) } finally { h.client.close() }
})

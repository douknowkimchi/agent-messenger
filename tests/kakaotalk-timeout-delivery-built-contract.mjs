import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'

// Compiled production packet/session/client and Bridge ledger; only the socket,
// clock and reply-source lookup are synthetic. No connection/login is opened.
const entry = process.env.SER5_SDK_CANDIDATE_ENTRY
const bridge = process.env.SER5_CONTRACT_BRIDGE_ROOT
assert.ok(entry && isAbsolute(entry), 'Set the exact compiled candidate client.js')
assert.ok(bridge && isAbsolute(bridge), 'Set the verified Bridge source root')
const loadSdk = name => import(pathToFileURL(join(dirname(entry), name)).href)
const { KakaoTalkClient } = await loadSdk('client.js')
const { LocoConnection } = await loadSdk('protocol/connection.js')
const { LocoSession } = await loadSdk('protocol/session.js')
const { createMessageIdGenerator } = await loadSdk('protocol/message-id.js')
const { encodePacket, decodePacket } = await loadSdk('protocol/packet.js')
const candidateIndex = pathToFileURL(join(dirname(entry), 'index.js')).href
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'agent-messenger/kakaotalk'
    ? { url: candidateIndex, shortCircuit: true }
    : nextResolve(specifier, context)
} })
let MessageCoreRuntime, AgentMessengerTransport, AtomicRuntimeStateStore, publicMessageId
try {
  const load = name => import(pathToFileURL(join(bridge, 'direct/agent-messenger', name)).href)
  ;({ MessageCoreRuntime } = await load('runtime-core.mjs'))
  ;({ AgentMessengerTransport } = await load('transport.mjs'))
  ;({ AtomicRuntimeStateStore } = await load('runtime-state.mjs'))
  ;({ publicMessageId } = await load('canonical-event.mjs'))
  assert.equal((await import('agent-messenger/kakaotalk')).KakaoTalkClient, KakaoTalkClient)
} finally { hook.deregister() }

function socketFixture(callbackCompleted) {
  const connection = new LocoConnection()
  const packets = [], pushes = []
  let callback, ready
  const started = new Promise(resolve => { ready = resolve })
  connection.socket = {
    write(bytes, cb) {
      const decoded = decodePacket(bytes)
      assert.ok(decoded, 'The actual packet encoder must produce a complete packet')
      packets.push(decoded.packet)
      callback = cb
      if (callbackCompleted) cb()
      ready()
      return true
    },
    destroy() { connection.handleClose() },
  }
  connection.onPush(packet => pushes.push(packet))
  function lateAcknowledgement() {
    callback?.()
    const sent = packets[0]
    connection.onData(encodePacket({ packetId: sent.packetId, statusCode: 0,
      method: sent.method, bodyType: 0, body: { logId: 42, chatId: 3, sendAt: 1 } }))
  }
  return { connection, packets, pushes, started, lateAcknowledgement }
}

for (const method of ['WRITE', 'FORWARD', 'CHATINFO']) {
  for (const callbackCompleted of [true, false]) {
    test(`${method} timeout: callback completed=${callbackCompleted}; late ACK is not a push`, async t => {
      const f = socketFixture(callbackCompleted)
      t.after(() => f.connection.close())
      t.mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const outcome = f.connection.sendPacket(method, { chatId: 3 })
          .then(value => ({ value }), error => ({ error }))
        await f.started
        await Promise.resolve()
        t.mock.timers.tick(15_000)
        const settled = await outcome
        assert.ok(settled.error instanceof Error)
        assert.match(settled.error.message, /LOCO packet timeout/)
        assert.equal(f.packets.length, 1)
        assert.equal(f.connection.pendingResolvers.size, 0)
        assert.equal(f.connection.timedOutIds.has(f.packets[0].packetId), true)
        f.lateAcknowledgement()
        await Promise.resolve()
        assert.deepEqual(f.pushes, [])
        assert.equal(f.connection.pendingResolvers.size, 0)
        assert.equal(f.connection.timedOutIds.size, 0)
      } finally { t.mock.timers.reset() }
    })
  }
}

for (const reply of [false, true]) {
  for (const callbackCompleted of [true, false]) {
    for (const sessionLost of [false, true]) {
      test(`Bridge ${reply ? 'reply' : 'plain'} timeout: callback completed=${callbackCompleted}, session lost=${sessionLost}; durable unknown`, async t => {
        const directory = await mkdtemp(join(tmpdir(), 'sdk-timeout-contract-'))
        t.after(() => rm(directory, { recursive: true }))
        const path = join(directory, 'state.json')
        const f = socketFixture(callbackCompleted)
        // The synthetic session skips login, so supply the same generator that
        // the real client now carries into each admitted session (SDK05).
        const session = new LocoSession(createMessageIdGenerator('synthetic-timeout'))
        session.connection = f.connection
        let admissions = 0
        const sdk = await new KakaoTalkClient({ connectionAdmission: () => { admissions++; return false } })
          .login({ oauthToken: 'synthetic-only', userId: '2', deviceUuid: 'synthetic-timeout' })
        sdk.state = { session, loginResult: { chatDatas: [] } }
        t.after(() => { sdk.close(); session.close() })
        const stateStore = await AtomicRuntimeStateStore.open(path)
        const transport = Object.create(AgentMessengerTransport.prototype)
        Object.assign(transport, { accountId: '1', selfUserId: '2', connectedOnce: true,
          stopped: false, sendInFlight: false, closingForSend: false,
          disconnectEpoch: 0, reconciledEpoch: 0, connectionAttempt: { outcome: 'resolved' },
          bundle: { client: sdk } })
        const runtime = Object.create(MessageCoreRuntime.prototype)
        Object.assign(runtime, { transport, stateStore,
          roomsByOpaqueId: new Map([['synthetic-room', { opaqueId: 'synthetic-room', nativeId: '3' }]]),
          commandPromises: new Map(), sendChain: Promise.resolve(), maximumCommands: 1000,
          eventChain: Promise.resolve(), sendOrderHolds: new Map(), maximumMessages: 100,
          now: () => new Date('2026-11-08T00:00:00Z'),
          resolveReplyTarget: async () => ({ log_id: '7', author_id: 8, message: 'synthetic original', type: 1 }),
          processMessage: async () => { throw new Error('UNEXPECTED_ARCHIVE_EFFECT') },
        })
        const request = { client_request_id: randomUUID(), room_id: 'synthetic-room', text: 'synthetic-timeout-body',
          ...(reply ? { reply_to_message_id: publicMessageId('1', '3', '7') } : {}) }
        let result
        t.mock.timers.enable({ apis: ['setTimeout'] })
        try {
          const operation = runtime.sendCommand(request)
          await Promise.race([f.started, operation.then(() => {
            throw new Error('SEND_SETTLED_BEFORE_SYNTHETIC_SOCKET_WRITE')
          })])
          await Promise.resolve()
          if (sessionLost) sdk.state = null
          t.mock.timers.tick(15_000)
          result = await operation
          assert.equal(result.status, 'unknown_outcome')
          assert.equal(result.archive_status, 'pending_identity_unknown')
          assert.equal(f.packets[0].method, 'WRITE')
          assert.equal(f.packets[0].body.type, reply ? 26 : 1)
          f.lateAcknowledgement()
          await Promise.resolve()
          assert.deepEqual(f.pushes, [])
        } finally { t.mock.timers.reset() }
        assert.deepEqual(await runtime.sendCommand(request), result)
        runtime.stateStore = await AtomicRuntimeStateStore.open(path)
        assert.deepEqual(await runtime.sendCommand(request), result)
        assert.equal(f.packets.length, 1)
        assert.equal(admissions, 0)
        assert.equal(f.connection.pendingResolvers.size, 0)
        assert.equal(transport.sendInFlight, false)
        assert.equal(runtime.commandPromises.size, 0)
        const saved = JSON.parse(await readFile(path, 'utf8'))
        assert.equal(saved.commands[request.client_request_id].status, 'unknown_outcome')
        assert.equal(saved.commands[request.client_request_id].retryPerformed, false)
        assert.equal(JSON.stringify(saved).includes(request.text), false)
      })
    }
  }
}

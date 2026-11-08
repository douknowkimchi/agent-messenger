import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'

// Run with an explicit compiled SDK candidate and the existing Bridge checkout.
// Only the provider session and reply-source lookup are synthetic. No sockets,
// credential loading, room-list reads, or archived/user content are involved.
const entry = process.env.SER5_SDK_CANDIDATE_ENTRY
const bridge = process.env.SER5_CONTRACT_BRIDGE_ROOT
assert.ok(entry && isAbsolute(entry), 'Set SER5_SDK_CANDIDATE_ENTRY to the compiled candidate client.js')
assert.ok(bridge && isAbsolute(bridge), 'Set SER5_CONTRACT_BRIDGE_ROOT to the verified Bridge checkout')
const { KakaoTalkClient } = await import(pathToFileURL(entry).href)
const bridgeModule = relative => import(pathToFileURL(join(bridge, 'direct/agent-messenger', relative)).href)
// Resolve the Bridge's SDK dependency to this candidate only in this test
// process. No package installation, lockfile change, or shared link is needed.
const candidateIndex = pathToFileURL(join(dirname(entry), 'index.js')).href
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'agent-messenger/kakaotalk'
    ? { url: candidateIndex, shortCircuit: true }
    : nextResolve(specifier, context)
} })
let MessageCoreRuntime, AgentMessengerTransport, AtomicRuntimeStateStore, publicMessageId
try {
  ;({ MessageCoreRuntime } = await bridgeModule('runtime-core.mjs'))
  ;({ AgentMessengerTransport } = await bridgeModule('transport.mjs'))
  ;({ AtomicRuntimeStateStore } = await bridgeModule('runtime-state.mjs'))
  ;({ publicMessageId } = await bridgeModule('canonical-event.mjs'))
  assert.equal((await import('agent-messenger/kakaotalk')).KakaoTalkClient, KakaoTalkClient)
} finally { hook.deregister() }

async function fixture(t, reply, response, connectionLoss = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sdk04-text-contract-'))
  const path = join(directory, 'state.json')
  let calls = 0, attemptsToReconnect = 0, wrongMethod = 0
  const sdk = await new KakaoTalkClient({ connectionAdmission: () => {
    attemptsToReconnect++
    return false
  } }).login({ oauthToken: 'synthetic-only', userId: '2', deviceUuid: 'synthetic-device' })
  t.after(async () => { sdk.close(); await rm(directory, { recursive: true }) })
  const dispatch = async () => {
    calls++
    if (connectionLoss) { sdk.state = null; throw new Error('Synthetic lost acknowledgement') }
    return response
  }
  const incorrect = async () => { wrongMethod++; throw new Error('Unexpected dispatch path') }
  sdk.state = { loginResult: { chatDatas: [] }, session: {
    sendMessage: reply ? incorrect : dispatch,
    sendReply: reply ? dispatch : incorrect,
    close() {},
  } }
  const stateStore = await AtomicRuntimeStateStore.open(path)
  const transport = Object.create(AgentMessengerTransport.prototype)
  Object.assign(transport, { accountId: '1', selfUserId: '2', connectedOnce: true,
    stopped: false, sendInFlight: false, closingForSend: false,
    disconnectEpoch: 0, reconciledEpoch: 0, connectionAttempt: { outcome: 'resolved' },
    bundle: { client: sdk },
  })
  const runtime = Object.create(MessageCoreRuntime.prototype)
  Object.assign(runtime, { transport, stateStore,
    roomsByOpaqueId: new Map([['synthetic-room', { opaqueId: 'synthetic-room', nativeId: '3' }]]),
    commandPromises: new Map(), sendChain: Promise.resolve(), maximumCommands: 1000,
    eventChain: Promise.resolve(), sendOrderHolds: new Map(), maximumMessages: 100,
    now: () => new Date('2026-11-08T00:00:00.000Z'),
    resolveReplyTarget: async () => ({ log_id: '42', author_id: 7, message: 'synthetic original', type: 1 }),
    processMessage: async () => { throw new Error('UNEXPECTED_ARCHIVE_EFFECT') },
  })
  const request = { client_request_id: randomUUID(), room_id: 'synthetic-room', text: 'synthetic-sensitive-payload',
    ...(reply ? { reply_to_message_id: publicMessageId('1', '3', '42') } : {}) }
  return { path, runtime, request, calls: () => calls, attemptsToReconnect: () => attemptsToReconnect,
    wrongMethod: () => wrongMethod }
}

for (const reply of [false, true]) {
  for (const [name, response, expected, connectionLoss] of [
    ['body refusal', { statusCode: 0, body: { status: -203 } }, 'rejected', false],
    ['packet refusal', { statusCode: -500, body: {} }, 'rejected', false],
    ['missing message id', { statusCode: 0, body: {} }, 'unknown_outcome', false],
    ['wrong room', { statusCode: 0, body: { chatId: 4, logId: 42 } }, 'unknown_outcome', false],
    ['socket sentinel', { statusCode: -1, body: { error: 'connection closed' } }, 'unknown_outcome', false],
    ['session loss', null, 'unknown_outcome', true],
  ]) {
    test(`compiled SDK ${reply ? 'reply' : 'plain'} ${name}: durable ${expected}, never replayed`, async t => {
      const f = await fixture(t, reply, response, connectionLoss)
      const result = await f.runtime.sendCommand(f.request)
      assert.equal(result.status, expected)
      assert.equal(result.archive_status, expected === 'rejected' ? 'not_archived' : 'pending_identity_unknown')
      assert.deepEqual(await f.runtime.sendCommand(f.request), result)
      f.runtime.stateStore = await AtomicRuntimeStateStore.open(f.path)
      assert.deepEqual(await f.runtime.sendCommand(f.request), result)
      assert.equal(f.calls(), 1)
      assert.equal(f.attemptsToReconnect(), 0)
      assert.equal(f.wrongMethod(), 0)
      const saved = JSON.parse(await readFile(f.path, 'utf8'))
      assert.equal(saved.commands[f.request.client_request_id].status, expected)
      assert.equal(saved.commands[f.request.client_request_id].retryPerformed, false)
      assert.equal(JSON.stringify(saved).includes(f.request.text), false)
      assert.equal(f.runtime.commandPromises.size, 0)
    })
  }
}

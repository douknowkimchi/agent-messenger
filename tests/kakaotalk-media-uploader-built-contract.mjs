import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { Long } from 'bson'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// The compiled uploader is real. Its existing socket owner is replaced only
// inside this process: no network or account credentials are used.
const entry = process.env.SER5_SDK_CANDIDATE_ENTRY
assert.ok(entry && isAbsolute(entry), 'Set the exact compiled candidate client.js')
const dir = join(dirname(entry), 'protocol')
const connectionUrl = pathToFileURL(join(dir, 'connection.js')).href
const stub = `let plan;
export function setPlan(value) { plan = value; }
export class LocoConnection {
  constructor() { this.plan = plan; this.index = plan.connections.length; plan.connections.push(this); this.writes = []; this.commands = []; this.closeCalls = 0; }
  async connectSecure(host, port) { this.destination = [host, port]; if (this.plan.connectError) throw this.plan.connectError; }
  onPush(handler) { this.push = handler; }
  onClose(handler) { this.onClosed = handler; }
  async sendPacket(method, body) {
    this.commands.push({ method, body });
    if (this.plan.closeAfterPost) setImmediate(() => this.onClosed?.());
    else setImmediate(() => this.push?.(this.plan.completePacket ?? { packetId: 2, method: 'COMPLETE', bodyType: 0, statusCode: 0, body: {} }));
    return this.plan.responseFor ? this.plan.responseFor(this.index) : this.plan.response;
  }
  async writeRaw(bytes) { this.writes.push(Buffer.from(bytes)); if (this.plan.writeError) throw this.plan.writeError; }
  close() { this.closeCalls++; }
}`
const indexUrl = pathToFileURL(join(dirname(entry), 'index.js')).href
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'agent-messenger/kakaotalk' ? { url: indexUrl, shortCircuit: true } : next(specifier, context)
}, load(url, context, next) {
  return url === connectionUrl ? { format: 'module', source: stub, shortCircuit: true } : next(url, context)
} })
let setPlan, uploadMediaToLoco, uploadMultiMediaEntry, KakaoTalkClient
let MessageCoreRuntime, AgentMessengerTransport, AtomicRuntimeStateStore
try {
  ;({ setPlan } = await import(connectionUrl))
  ;({ uploadMediaToLoco, uploadMultiMediaEntry } = await import(pathToFileURL(join(dir, 'media-uploader.js')).href))
  ;({ KakaoTalkClient } = await import(pathToFileURL(entry).href))
  const bridge = process.env.SER5_CONTRACT_BRIDGE_ROOT
  assert.ok(bridge && isAbsolute(bridge), 'Set the verified Bridge checkout')
  const loadBridge = file => import(pathToFileURL(join(bridge, 'direct/agent-messenger', file)).href)
  ;({ MessageCoreRuntime } = await loadBridge('runtime-core.mjs'))
  ;({ AgentMessengerTransport } = await loadBridge('transport.mjs'))
  ;({ AtomicRuntimeStateStore } = await loadBridge('runtime-state.mjs'))
} finally { hook.deregister() }
const options = { shipToken: 'synthetic-ticket', shipHost: 'example.invalid', shipPort: 443,
  chatId: Long.fromInt(3), msgType: 18, userId: '2', filename: 'synthetic.txt',
  data: Buffer.from('abcde'), deviceType: 'tablet' }
const response = (body = {}, statusCode = 0) => ({ packetId: 1, method: 'POST', bodyType: 0, statusCode, body })
function fixture(t, input = {}) {
  const plan = { response: response(), connections: [], ...input }
  setPlan(plan); t.after(() => setPlan(null)); return plan
}
for (const [opcode, send] of [['POST', uploadMediaToLoco], ['MPOST', uploadMultiMediaEntry]]) {
  for (const offset of [undefined, 0, 2, 5]) {
    test(`${opcode} valid offset ${String(offset)} preserves exact suffix and closes once`, async t => {
      const plan = fixture(t, { response: response(offset === undefined ? {} : { o: offset }) })
      const result = await send(options); const conn = plan.connections[0]
      assert.equal(result.postStatusCode, 0); assert.ok(result.completePacket)
      assert.equal(result.postOffset, offset ?? 0)
      assert.deepEqual(Buffer.concat(conn.writes), options.data.subarray(offset ?? 0))
      assert.equal(conn.closeCalls, 1); assert.equal(conn.commands.length, 1)
      assert.equal(conn.commands[0].method, opcode)
      assert.equal(conn.commands[0].body.k, options.shipToken)
    })
  }
  for (const [name, bad] of [
    ['packet rejection', response({}, -203)], ['body rejection', response({ status: -203 })],
    ['socket sentinel', response({ error: 'connection closed' }, -1)], ['bad status type', response({ status: '0' })],
    ['negative offset', response({ o: -1 })], ['fractional offset', response({ o: 0.5 })],
    ['oversize offset', response({ o: 6 })], ['text offset', response({ o: '0' })],
  ]) {
    test(`${opcode} ${name}: no raw payload and connection is closed`, async t => {
      const plan = fixture(t, { response: bad })
      await assert.rejects(send(options))
      const conn = plan.connections[0]
      assert.deepEqual(conn.writes, []); assert.equal(conn.closeCalls, 1)
    })
  }
}
test('connect failure still closes the allocated connection owner', async t => {
  const failure = new Error('Synthetic connect failure'); const plan = fixture(t, { connectError: failure })
  await assert.rejects(uploadMediaToLoco(options), error => error === failure)
  assert.equal(plan.connections[0].closeCalls, 1); assert.deepEqual(plan.connections[0].commands, [])
})
test('raw write failure closes the connection and does not retry', async t => {
  const failure = new Error('Synthetic write failure'); const plan = fixture(t, { writeError: failure })
  await assert.rejects(uploadMediaToLoco(options), error => error === failure)
  assert.equal(plan.connections.length, 1); assert.equal(plan.connections[0].closeCalls, 1)
  assert.equal(plan.connections[0].writes.length, 1)
})
test('close-release: an upload connection closing before COMPLETE ends as unacknowledged', { timeout: 1000 }, async t => {
  const plan = fixture(t, { closeAfterPost: true })
  const result = await uploadMediaToLoco(options)
  assert.equal(result.completePacket, null); assert.equal(result.postStatusCode, 0)
  assert.equal(plan.connections[0].closeCalls, 1); assert.equal(plan.connections.length, 1)
})

// One connected path: actual SDK -> actual uploader -> synthetic socket owner,
// with actual Bridge command/state owners for terminal and duplicate behavior.
async function connected(t, kind, planInput = {}, forwardReply = response({ logId: '99', chatId: '3' })) {
  const plan = fixture(t, planInput)
  const calls = { ship: 0, mship: 0, forward: 0, acquire: 0 }
  const sdk = await new KakaoTalkClient({ connectionAdmission: () => { calls.acquire++; return false } })
    .login({ oauthToken: 'synthetic-only', userId: '2', deviceUuid: 'synthetic-media' })
  sdk.state = { loginResult: { chatDatas: [] }, session: {
    async shipMedia() { calls.ship++; return response({ k: 'ticket', vh: 'example.invalid', p: 443 }) },
    async shipMultiMedia() { calls.mship++; return response({ kl: ['a', 'b'], vhl: ['example.invalid', 'example.invalid'], pl: [443, 443] }) },
    async forwardChat() { calls.forward++; return forwardReply }, close() {},
  } }
  t.after(() => sdk.close())
  const image = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
  image.writeUInt32BE(1, 16); image.writeUInt32BE(1, 20)
  const items = [0, 1].map(i => ({ data: Buffer.from(image), filename: `synthetic-${i}.png`, mime: 'image/png' }))
  return { plan, calls, sdk, items, send: () => kind === 'file'
    ? sdk.sendFile('3', Buffer.from('synthetic-payload'), 'synthetic.txt')
    : sdk.sendMultiPhoto('3', items) }
}
for (const kind of ['file', 'photos']) {
  test(`connected ${kind}: actual uploader and SDK preserve successful acknowledgement`, async t => {
    const completePacket = { ...response({ chatLog: { chatId: '3', logId: '99', sendAt: 1 } }), method: 'COMPLETE' }
    const f = await connected(t, kind, { completePacket })
    const result = await f.send()
    assert.equal(result.success, true); assert.equal(result.log_id, '99')
    assert.equal(f.calls.acquire, 0); assert.equal(f.calls.forward, kind === 'photos' ? 1 : 0)
    assert.equal(f.plan.connections.length, kind === 'photos' ? 2 : 1)
    assert.ok(f.plan.connections.every(c => c.closeCalls === 1))
  })
}
for (const [kind, name, planInput, finalReply, expected] of [
  ['file', 'connection closes before COMPLETE', { closeAfterPost: true }, undefined, 'unknown_outcome'],
  ['file', 'POST body refuses payload', { response: response({ status: -203 }) }, undefined, 'unknown_outcome'],
  ['file', 'COMPLETE has no message identity', {}, undefined, 'unknown_outcome'],
  ['photos', 'one MPOST refuses while the other completes', { responseFor: i => response(i ? {} : { status: -203 }) }, undefined, 'unknown_outcome'],
  ['photos', 'final FORWARD refusal', {}, response({ status: -203 }), 'rejected'],
]) {
  test(`connected Bridge ${kind}/${name}: exact durable terminal without replay`, async t => {
    const f = await connected(t, kind, planInput, finalReply)
    const directory = await mkdtemp(join(tmpdir(), 'sdk04-connected-media-')); const path = join(directory, 'state.json')
    t.after(() => rm(directory, { recursive: true }))
    const transport = Object.create(AgentMessengerTransport.prototype)
    Object.assign(transport, { accountId: '1', selfUserId: '2', connectedOnce: true, stopped: false,
      sendInFlight: false, closingForSend: false, disconnectEpoch: 0, reconciledEpoch: 0,
      connectionAttempt: { outcome: 'resolved' }, bundle: { client: f.sdk } })
    let downstreamWrites = 0
    const runtime = Object.create(MessageCoreRuntime.prototype)
    Object.assign(runtime, { transport, stateStore: await AtomicRuntimeStateStore.open(path),
      roomsByOpaqueId: new Map([['synthetic-room', { opaqueId: 'synthetic-room', nativeId: '3' }]]),
      commandPromises: new Map(), sendChain: Promise.resolve(), maximumCommands: 1000,
      eventChain: Promise.resolve(), sendOrderHolds: new Map(), maximumMessages: 100,
      now: () => new Date('2026-11-08T00:00:00.000Z'),
      persistExternallyIssuedMessageCursor: async () => { downstreamWrites++; throw new Error('Unexpected successful send') },
      processMessage: async () => { downstreamWrites++; throw new Error('Unexpected archive') } })
    const common = { client_request_id: randomUUID(), room_id: 'synthetic-room' }
    const request = kind === 'file' ? { ...common, data: Buffer.from('synthetic-sensitive-payload'), filename: 'synthetic.txt', mime: 'text/plain' }
      : { ...common, kind: 'photos', items: f.items }
    const submit = () => kind === 'file' ? runtime.sendAttachmentCommand(request) : runtime.sendMediaCommand(request)
    const result = await submit(); assert.equal(result.status, expected)
    assert.equal(result.archive_status, expected === 'rejected' ? 'not_archived' : 'pending_identity_unknown')
    const counts = { ...f.calls }; const connections = f.plan.connections.length
    assert.deepEqual(await submit(), result)
    runtime.stateStore = await AtomicRuntimeStateStore.open(path)
    assert.deepEqual(await submit(), result); assert.deepEqual(f.calls, counts)
    assert.equal(f.plan.connections.length, connections); assert.equal(f.calls.acquire, 0)
    assert.equal(f.calls.forward, expected === 'rejected' ? 1 : 0)
    assert.ok(f.plan.connections.every(c => c.closeCalls === 1))
    if (name.includes('refuses')) assert.equal(f.plan.connections[0].writes.length, 0)
    const saved = await readFile(path, 'utf8')
    assert.equal(JSON.parse(saved).commands[request.client_request_id].retryPerformed, false)
    assert.equal(saved.includes('synthetic-sensitive-payload'), false)
    assert.equal(downstreamWrites, 0); assert.equal(runtime.commandPromises.size, 0)
  })
}

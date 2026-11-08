import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'

// Real compiled SDK and Bridge owners; only the provider session/upload are synthetic.
// This does not test sockets, server credentials, real media, or deployed packages.
const entry = process.env.SER5_SDK_CANDIDATE_ENTRY
const bridge = process.env.SER5_CONTRACT_BRIDGE_ROOT
assert.ok(entry && isAbsolute(entry), 'Set the exact compiled client.js candidate')
assert.ok(bridge && isAbsolute(bridge), 'Set the verified Bridge checkout')
const clientUrl = pathToFileURL(entry).href
const indexUrl = pathToFileURL(join(dirname(entry), 'index.js')).href
const mediaUrl = pathToFileURL(join(dirname(entry), 'protocol/media-uploader.js')).href
const stub = `let handlers;
export function setUploadHandlers(value) { handlers = value; }
export function uploadMediaToLoco(value) { if (!handlers) throw new Error('Missing fixture'); return handlers.single(value); }
export function uploadMultiMediaEntry(value) { if (!handlers) throw new Error('Missing fixture'); return handlers.multi(value); }`
const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'agent-messenger/kakaotalk' ? { url: indexUrl, shortCircuit: true } : next(specifier, context)
  },
  load(url, context, next) {
    return url === mediaUrl ? { format: 'module', source: stub, shortCircuit: true } : next(url, context)
  },
})
let KakaoTalkClient, setUploadHandlers, MessageCoreRuntime, AgentMessengerTransport, AtomicRuntimeStateStore
const bridgeModule = path => import(pathToFileURL(join(bridge, 'direct/agent-messenger', path)).href)
try {
  ;({ KakaoTalkClient } = await import(clientUrl))
  ;({ setUploadHandlers } = await import(mediaUrl))
  ;({ MessageCoreRuntime } = await bridgeModule('runtime-core.mjs'))
  ;({ AgentMessengerTransport } = await bridgeModule('transport.mjs'))
  ;({ AtomicRuntimeStateStore } = await bridgeModule('runtime-state.mjs'))
  assert.equal((await import('agent-messenger/kakaotalk')).KakaoTalkClient, KakaoTalkClient)
} finally { hook.deregister() }

const ack = (body = {}, statusCode = 0) => ({ packetId: 1, method: 'COMPLETE', bodyType: 0, statusCode, body })
const message = () => ({ chatId: '3', logId: '9007199254740993', sendAt: 1700000099 })
const upload = (completePacket = ack({ chatLog: message() }), postStatusCode = 0) => ({ completePacket, postStatusCode, postOffset: 0 })
const png = Buffer.alloc(24)
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20)
const photos = () => [0, 1].map(i => ({ data: Buffer.from(png), filename: `synthetic-${i}.png` }))
const unknown = error => error.responseFailureKind === 'transient_or_unknown'
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function fixture(t, options = {}) {
  const calls = { ship: 0, mship: 0, single: 0, multi: 0, forward: 0, acquire: 0 }
  const sdk = await new KakaoTalkClient({ connectionAdmission: () => { calls.acquire++; return false } })
    .login({ oauthToken: 'synthetic-only', userId: '2', deviceUuid: 'synthetic-media' })
  const session = {
    async shipMedia() { calls.ship++; return options.ship ? options.ship(sdk) : ack({ k: 'synthetic-ticket', vh: 'example.invalid', p: 443 }) },
    async shipMultiMedia() { calls.mship++; return options.mship ? options.mship(sdk) : ack({ kl: ['a', 'b'], vhl: ['example.invalid', 'example.invalid'], pl: [443, 443] }) },
    async forwardChat() { calls.forward++; return options.forward ? options.forward(sdk) : ack(message()) },
    close() {},
  }
  sdk.state = { session, loginResult: { chatDatas: [] } }
  setUploadHandlers({
    single: value => { calls.single++; return options.single ? options.single(sdk, value) : upload() },
    multi: value => { const i = calls.multi++; return options.multi ? options.multi(sdk, value, i) : upload(ack({})) },
  })
  t.after(() => { sdk.close(); setUploadHandlers(null) })
  return { sdk, calls, send: () => sdk.sendFile('3', Buffer.from('synthetic-payload'), 'synthetic.txt'),
    sendPhotos: () => sdk.sendMultiPhoto('3', photos()) }
}

for (const method of ['sendFile', 'sendPhoto', 'sendVideo', 'sendAudio']) {
  test(`media ${method}: exact successful COMPLETE`, async t => {
    const f = await fixture(t)
    const result = await f.sdk[method]('3', Buffer.from(png), 'synthetic.png')
    assert.equal(result.success, true); assert.equal(result.log_id, message().logId)
    assert.equal(result.chat_id, '3'); assert.equal(f.calls.single, 1); assert.equal(f.calls.acquire, 0)
  })
}

const uncertainUploads = [
  ['missing COMPLETE', upload(null)],
  ['nonzero POST without retained raw rejection', upload(null, -203)],
  ['socket sentinel', upload(ack({ error: 'connection closed' }, -1))],
  ['missing log id', upload(ack({ chatLog: { chatId: '3' } }))],
  ['zero log id', upload(ack({ chatLog: { ...message(), logId: 0 } }))],
  ['unsafe log number', upload(ack({ chatLog: { ...message(), logId: 9007199254740992 } }))],
  ['wrong message room', upload(ack({ chatLog: { ...message(), chatId: '4' } }))],
  ['invalid complete body status', upload(ack({ status: '0', chatLog: message() }))],
]
for (const [name, result] of uncertainUploads) {
  test(`single ${name}: unknown without replay`, async t => {
    const f = await fixture(t, { single: () => result })
    await assert.rejects(f.send(), unknown)
    assert.equal(f.calls.single, 1); assert.equal(f.calls.ship, 1); assert.equal(f.calls.acquire, 0)
  })
}
for (const [name, options] of [
  ['SHIP refusal', { ship: () => ack({ status: -203 }) }],
  ['COMPLETE packet refusal', { single: () => upload(ack({}, -203)) }],
  ['COMPLETE body refusal', { single: () => upload(ack({ status: -203 })) }],
]) {
  test(`single ${name}: explicit rejected result`, async t => {
    const f = await fixture(t, options)
    assert.equal((await f.send()).success, false)
    assert.equal(f.calls.single, name === 'SHIP refusal' ? 0 : 1)
  })
}
test('single upload loses the main session: never acquires or uploads again', async t => {
  const f = await fixture(t, { single: sdk => { sdk.state = null; throw new Error('Synthetic upload response loss') } })
  await assert.rejects(f.send(), unknown)
  assert.equal(f.calls.single, 1); assert.equal(f.calls.acquire, 0)
})
test('single stale SHIP response does not open another upload', async t => {
  const f = await fixture(t, { ship: sdk => { sdk.state = null; return ack({ k: 'a', vh: 'example.invalid', p: 443 }) } })
  await assert.rejects(f.send(), unknown)
  assert.equal(f.calls.single, 0); assert.equal(f.calls.acquire, 0)
})
test('single valid final acknowledgement survives later main-session loss', async t => {
  const f = await fixture(t, { single: sdk => { sdk.state = null; return upload() } })
  assert.equal((await f.send()).success, true)
  assert.equal(f.calls.single, 1); assert.equal(f.calls.acquire, 0)
})

test('photos: two complete uploads produce exactly one FORWARD', async t => {
  const f = await fixture(t)
  assert.equal((await f.sendPhotos()).log_id, message().logId)
  assert.deepEqual(f.calls, { ship: 0, mship: 1, single: 0, multi: 2, forward: 1, acquire: 0 })
})
for (const [name, result] of [
  ['missing completion', upload(null)], ['POST rejected', upload(null, -203)],
  ['COMPLETE rejected', upload(ack({ status: -203 }))],
]) {
  test(`photos ${name}: no FORWARD and unknown`, async t => {
    const f = await fixture(t, { multi: (_sdk, _value, i) => i ? upload(ack({})) : result })
    await assert.rejects(f.sendPhotos(), unknown)
    assert.equal(f.calls.multi, 2); assert.equal(f.calls.forward, 0); assert.equal(f.calls.acquire, 0)
  })
}
for (const change of ['lost', 'replaced', 'closed']) {
  test(`photos ${change} session after uploads: no stale FORWARD`, async t => {
    const f = await fixture(t, { multi: (sdk, _value, i) => {
      if (i === 1) { if (change === 'closed') sdk.close(); else sdk.state = change === 'lost' ? null : { session: { close() {} }, loginResult: {} } }
      return upload(ack({}))
    } })
    await assert.rejects(f.sendPhotos(), unknown)
    assert.equal(f.calls.forward, 0); assert.equal(f.calls.multi, 2); assert.equal(f.calls.acquire, 0)
  })
}
for (const [name, response, rejected] of [
  ['missing id', ack({}), false], ['wrong room', ack({ ...message(), chatId: '4' }), false],
  ['body refusal', ack({ status: -203 }), true], ['connection closed', ack({ error: 'connection closed' }, -1), false],
]) {
  test(`photos FORWARD ${name}: preserves result classification`, async t => {
    const f = await fixture(t, { forward: () => response })
    if (rejected) assert.equal((await f.sendPhotos()).success, false)
    else await assert.rejects(f.sendPhotos(), unknown)
    assert.equal(f.calls.forward, 1); assert.equal(f.calls.acquire, 0)
  })
}
test('photos: one failed upload waits for its still-reading sibling before returning', async t => {
  const entered = deferred(), release = deferred(); let settled = false, siblingDone = false
  const f = await fixture(t, { multi: async (_sdk, value, i) => {
    if (i === 0) throw new Error('Synthetic first upload failure')
    entered.resolve(); await release.promise
    assert.deepEqual(Buffer.from(value.data), png); siblingDone = true
    return upload(ack({}))
  } })
  const outcome = f.sendPhotos().then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
  await entered.promise; await tick()
  const returnedTooEarly = settled
  release.resolve(); const result = await outcome
  assert.equal(returnedTooEarly, false); assert.equal(siblingDone, true)
  assert.ok(result.error && unknown(result.error)); assert.equal(f.calls.forward, 0)
})

// Exercise actual durable command ownership, not only the SDK result shape.
for (const kind of ['file', 'photos']) {
  for (const [name, failure, expected] of [
    ['lost completion', 'missing', 'unknown_outcome'],
    ['wrong final room', 'wrong-room', 'unknown_outcome'],
    ['explicit final refusal', 'rejected', 'rejected'],
  ]) {
    test(`Bridge ${kind}/${name}: persisted terminal and duplicate/reopen never replay`, async t => {
      const options = kind === 'file'
        ? { single: () => upload(failure === 'missing' ? null : failure === 'rejected' ? ack({ status: -203 }) : ack({ chatLog: { ...message(), chatId: '4' } })) }
        : { multi: (_sdk, _value, i) => failure === 'missing' && i === 0 ? upload(null) : upload(ack({})),
            forward: () => failure === 'rejected' ? ack({ status: -203 }) : ack({ ...message(), chatId: '4' }) }
      const f = await fixture(t, options)
      const directory = await mkdtemp(join(tmpdir(), 'sdk04-media-ledger-')); const path = join(directory, 'state.json')
      t.after(() => rm(directory, { recursive: true }))
      const transport = Object.create(AgentMessengerTransport.prototype)
      Object.assign(transport, { accountId: '1', selfUserId: '2', connectedOnce: true, stopped: false,
        sendInFlight: false, closingForSend: false, disconnectEpoch: 0, reconciledEpoch: 0,
        connectionAttempt: { outcome: 'resolved' }, bundle: { client: f.sdk } })
      let cursorWrites = 0, archiveCalls = 0
      const runtime = Object.create(MessageCoreRuntime.prototype)
      Object.assign(runtime, { transport, stateStore: await AtomicRuntimeStateStore.open(path),
        roomsByOpaqueId: new Map([['synthetic-room', { opaqueId: 'synthetic-room', nativeId: '3' }]]),
        commandPromises: new Map(), sendChain: Promise.resolve(), maximumCommands: 1000,
        eventChain: Promise.resolve(), sendOrderHolds: new Map(), maximumMessages: 100,
        now: () => new Date('2026-11-08T00:00:00.000Z'),
        persistExternallyIssuedMessageCursor: async () => { cursorWrites++; throw new Error('Unexpected cursor write') },
        processMessage: async () => { archiveCalls++; throw new Error('Unexpected archive call') } })
      const common = { client_request_id: randomUUID(), room_id: 'synthetic-room' }
      const request = kind === 'file' ? { ...common, data: Buffer.from('synthetic-sensitive-payload'), filename: 'synthetic.txt', mime: 'text/plain' }
        : { ...common, kind: 'photos', items: photos().map(p => ({ ...p, mime: 'image/png' })) }
      const submit = () => kind === 'file' ? runtime.sendAttachmentCommand(request) : runtime.sendMediaCommand(request)
      const first = await submit(); assert.equal(first.status, expected)
      assert.equal(first.archive_status, expected === 'rejected' ? 'not_archived' : 'pending_identity_unknown')
      const counts = { ...f.calls }
      assert.deepEqual(await submit(), first)
      runtime.stateStore = await AtomicRuntimeStateStore.open(path)
      assert.deepEqual(await submit(), first); assert.deepEqual(f.calls, counts)
      assert.equal(f.calls.acquire, 0)
      const saved = await readFile(path, 'utf8')
      assert.equal(JSON.parse(saved).commands[request.client_request_id].retryPerformed, false)
      assert.equal(saved.includes('synthetic-sensitive-payload'), false)
      assert.equal(runtime.commandPromises.size, 0)
      assert.equal(cursorWrites, 0); assert.equal(archiveCalls, 0)
    })
  }
}

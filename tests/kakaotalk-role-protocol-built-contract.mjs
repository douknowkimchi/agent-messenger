import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CIPHERS, checkServerIdentity, createSecureContext } from 'node:tls'
import { Long, serialize } from 'bson'

// Actual compiled client/session; only the connection boundary is synthetic.
// No provider sockets, stored credentials, device registration or live account.
const entry = process.env.SER5_SDK_CANDIDATE_ENTRY
assert.ok(entry && isAbsolute(entry), 'Set the absolute compiled candidate client.js')
assert.ok(process.env.AGENT_MESSENGER_CONFIG_DIR, 'Use an isolated config directory')
const base = dirname(entry)
const protocol = name => pathToFileURL(join(base, 'protocol', name)).href
const fixture = { connections: [], tlsOptions: [], nativeId: 100 }
globalThis.__ser5RoleContract = fixture
class FakeConnection {
  constructor() { this.calls = []; this.closed = 0; fixture.connections.push(this) }
  async connectTls(host, port, options) { this.calls.push({ transport: 'tls', host, port, options }) }
  async connectSecure(host, port) { this.calls.push({ transport: 'secure', host, port }) }
  async sendPacket(method, body) {
    this.calls.push({ method, body })
    if (method === 'GETCONF') return { statusCode: 0, body: { hosts: ['checkin.invalid'], wifi: { ports: [995] } } }
    if (method === 'CHECKIN') return { statusCode: 0, body: { host: 'messaging.invalid', port: 5242 } }
    if (method === 'LOGINLIST') return { statusCode: 0, body: { status: 0, chatDatas: [], eof: true, lastTokenId: Long.ZERO, lastChatId: Long.ZERO } }
    return { statusCode: 0, body: { chatId: body.chatId, logId: Long.fromNumber(++fixture.nativeId), sendAt: 1 } }
  }
  onPush(handler) { this.push = handler }
  onClose(handler) { this.closedHandler = handler }
  close() { this.closed++ }
}
fixture.Connection = FakeConnection
const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const fakeConnection = moduleUrl('export const LocoConnection = globalThis.__ser5RoleContract.Connection')
const fakeNet = moduleUrl('export function connect(){throw new Error("UNEXPECTED_REAL_NETWORK")}')
const fakeTls = moduleUrl(`export const DEFAULT_CIPHERS=${JSON.stringify(DEFAULT_CIPHERS)};
export function connect(options, ready) {
  globalThis.__ser5RoleContract.tlsOptions.push(options);
  const socket={on(){return socket},destroy(){}};
  queueMicrotask(ready); return socket;
}`)
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'node:net') return { url: fakeNet, shortCircuit: true }
  if (specifier === 'node:tls') return { url: fakeTls, shortCircuit: true }
  const resolved = nextResolve(specifier, context)
  return resolved.url === protocol('connection.js')
    ? { url: fakeConnection, shortCircuit: true } : resolved
} })
let KakaoTalkClient, LocoSession, NativeConnection, config
try {
  ;({ KakaoTalkClient } = await import(pathToFileURL(entry).href))
  ;({ LocoSession } = await import(protocol('session.js')))
  ;({ LocoConnection: NativeConnection } = await import(protocol('connection.js') + '?tls-boundary'))
  config = await import(protocol('config.js'))
} finally { hook.deregister() }

async function connect(t, role) {
  const start = fixture.connections.length
  let admissions = 0
  const client = await new KakaoTalkClient({ connectionAdmission: () => { admissions++; return true } })
    .login({ oauthToken: 'synthetic-only', userId: '2', deviceUuid: `role-${role}`, deviceType: role })
  t.after(() => client.close())
  const session = await client.acquireSession()
  return { client, session, connections: fixture.connections.slice(start), admissions: () => admissions }
}
for (const role of ['pc', 'tablet']) {
  test(`${role}: actual login keeps booking/checkin and chooses role-specific messaging`, async t => {
    const f = await connect(t, role)
    assert.equal(f.admissions(), 1)
    assert.equal(f.connections.length, 3)
    const [booking, checkin, messaging] = f.connections
    assert.equal(booking.calls[0].transport, 'tls'); assert.equal(booking.calls[0].port, 443)
    assert.equal(checkin.calls[0].transport, 'secure'); assert.equal(checkin.calls[0].port, 995)
    assert.equal(messaging.calls[0].transport, role === 'tablet' ? 'tls' : 'secure')
    assert.equal(messaging.calls[0].port, role === 'tablet' ? 10009 : 5242)
    if (role === 'tablet') assert.equal(messaging.calls[0].options.servername, 'kakao.com')
    const login = messaging.calls.find(c => c.method === 'LOGINLIST').body
    const checkedIn = checkin.calls.find(c => c.method === 'CHECKIN').body
    assert.equal(checkedIn.countryISO, 'KR'); assert.equal(checkedIn.useSub, role === 'tablet')
    assert.equal(login.rp.buffer.toString('hex'), '0000ffff0000')
    assert.equal(Object.hasOwn(login, 'isSw'), role === 'tablet')
    if (role === 'tablet') assert.equal(login.isSw, false)
  })
  for (const method of ['sendMessage', 'sendReply', 'sendAttachment']) {
    test(`${role}/${method}: actual WRITE preserves payload and limits new headers to tablets`, async t => {
      const f = await connect(t, role)
      const extra = { src_logId: '9007199254740993', src_userId: '7', label: 'synthetic' }
      if (method === 'sendMessage') await f.session.sendMessage(Long.ONE, 'hello')
      if (method === 'sendReply') await f.session.sendReply(Long.ONE, 'reply', extra)
      if (method === 'sendAttachment') await f.session.sendAttachment(Long.ONE, 18, extra, 'file')
      const body = f.connections[2].calls.find(c => c.method === 'WRITE').body
      const expected = method === 'sendMessage' ? { chatId: Long.ONE, msg: 'hello', type: 1, noSeen: false }
        : { chatId: Long.ONE, msg: method === 'sendReply' ? 'reply' : 'file', type: method === 'sendReply' ? 26 : 18, noSeen: false, extra: JSON.stringify(extra) }
      if (role === 'pc') assert.deepEqual(serialize(body), serialize(expected))
      else {
        assert.ok(Long.isLong(body.msgId)); assert.ok(body.msgId.toNumber() > 0)
        assert.deepEqual(body, { ...expected, msgId: body.msgId, scope: 1, silence: false, extra: expected.extra ?? '{}' })
      }
    })
  }
  test(`${role}: grouped-photo FORWARD retains its existing wire shape`, async t => {
    const f = await connect(t, role); const extra = { kl: ['synthetic-a', 'synthetic-b'] }
    await f.session.forwardChat(Long.ONE, 27, extra)
    const body = f.connections[2].calls.find(c => c.method === 'FORWARD').body
    assert.deepEqual(body, { chatId: Long.ONE, msg: '', type: 27, noSeen: false, extra: JSON.stringify(extra) })
  })
}
test('pc: default WRITE paths never consume the message-id generator', async () => {
  let issued = 0
  const session = new LocoSession(() => { issued++; return 123 })
  const connection = new FakeConnection()
  session.connection = connection
  session.deviceType = 'pc'
  const extra = { src_logId: '9007199254740993', src_userId: '7', label: 'synthetic' }
  await session.sendMessage(Long.ONE, 'hello')
  await session.sendReply(Long.ONE, 'reply', extra)
  await session.sendAttachment(Long.ONE, 18, extra, 'file')
  assert.equal(issued, 0)
  const writes = connection.calls.filter(call => call.method === 'WRITE')
  assert.equal(writes.length, 3)
  for (const call of writes) assert.equal(Object.hasOwn(call.body, 'msgId'), false)
})
test('tablet: one generator survives a permitted reconnect with a frozen clock', async t => {
  t.mock.method(Date, 'now', () => 1700000000000)
  const f = await connect(t, 'tablet')
  await f.session.sendMessage(Long.ONE, 'first')
  const first = f.connections[2].calls.find(c => c.method === 'WRITE').body.msgId
  f.session.close(); f.connections[2].closedHandler()
  const secondSession = await f.client.acquireSession()
  await secondSession.sendMessage(Long.ONE, 'second')
  const last = fixture.connections.at(-1).calls.find(c => c.method === 'WRITE').body.msgId
  assert.ok(Long.isLong(first) && Long.isLong(last)); assert.ok(last.greaterThan(first))
  assert.equal(f.admissions(), 2)
})
test('denied admission does not open booking/checkin/messaging connections', async t => {
  const before = fixture.connections.length
  const client = await new KakaoTalkClient({ connectionAdmission: () => false })
    .login({ oauthToken: 'synthetic', userId: '2', deviceUuid: 'denied', deviceType: 'tablet' })
  t.after(() => client.close())
  await assert.rejects(client.acquireSession(), e => e.code === 'connection_admission_denied')
  assert.equal(fixture.connections.length, before)
})
test('actual TLS adapter forwards SNI and cannot disable certificate verification', async () => {
  const c = new NativeConnection()
  try {
    await c.connectTls('routing.invalid', 10009, { servername: 'kakao.com', rejectUnauthorized: false })
    assert.equal(fixture.tlsOptions.at(-1).servername, 'kakao.com')
    assert.equal(fixture.tlsOptions.at(-1).rejectUnauthorized, true)
  } finally { c.close() }
})
test('selected TLS offers are accepted by local OpenSSL; service-name verification stays enabled', () => {
  assert.equal(typeof config.createMessagingTlsOptions, 'function')
  for (const runtime of [['linux', '24.14.1', '3.5.5'], ['darwin', '26.13.0', '4.1.0'], [process.platform, process.versions.node, process.versions.openssl]]) {
    const options = config.createMessagingTlsOptions(...runtime)
    assert.doesNotThrow(() => createSecureContext(options))
    assert.equal(options.servername, 'kakao.com')
    assert.equal(options.checkServerIdentity, undefined)
  }
  const cert = { subjectaltname: 'DNS:kakao.com' }
  assert.equal(checkServerIdentity('kakao.com', cert), undefined)
  assert.ok(checkServerIdentity('routing.invalid', cert) instanceof Error)
})

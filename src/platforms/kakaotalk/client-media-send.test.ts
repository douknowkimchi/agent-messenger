// Media send regressions on fake peers only: a scripted session, a local LOCO
// media server speaking the real secure framing, and a local HTTP server. No
// Kakao host is contacted and no account is used.
// Runnable without Bun:
// node --import tsx --test src/platforms/kakaotalk/client-media-send.test.ts
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { type IncomingHttpHeaders, type Server as HttpServer, createServer as createHttpServer } from 'node:http'
import { type AddressInfo, type Server as TcpServer, type Socket, createServer as createTcpServer } from 'node:net'
import { test } from 'node:test'

import { BSON, Int32, Long } from 'bson'

import { KakaoTalkClient, KakaoTalkError } from './client'
import type { MediaIo } from './media-send'
import { LocoConnection } from './protocol/connection'
import { LocoCrypto } from './protocol/crypto'
import { waitDirectReady } from './protocol/media-direct'
import { MediaStepError } from './protocol/media-outcome'
import { decodePacket, encodePacket } from './protocol/packet'
import type { LocoPacket } from './protocol/types'

const ROOM = '9007199254740993'
const LOG = '9007199254740995'
const TOKEN = 'synthetic-token'
const DEVICE = 'synthetic-device'
const UPLOAD_KEY = 'synthetic-upload-key'
const RESOURCE = 'synthetic/bucket/object/server-file.dat'
const SIGNED_URL = 'https://kage.talk.kakao.com/offset-up/synthetic/ready/?credential=synthetic&signature=synthetic'
const CHUNK = 4 * 1024 * 1024
const MIB = 1024 * 1024
// The user's failed attachment was about this size; the Bridge accepts 16 MiB.
const SIZE_9_4_MB = 9_856_615
const SIZE_LIMIT = 16 * MIB

const sha1 = (data: Uint8Array) => createHash('sha1').update(data).digest('hex')
const packet = (body: Record<string, unknown> = {}, statusCode = 0): LocoPacket => ({
  packetId: 1,
  statusCode,
  method: '',
  bodyType: 0,
  body,
})
// What LocoConnection.handleClose hands a pending request.
const closedPacket = () => packet({ error: 'connection closed' }, -1)

function png(width: number, height: number, size = 64): Buffer {
  const data = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
  data.writeUInt32BE(13, 8)
  data.write('IHDR', 12, 'ascii')
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}

const photos = () => [
  { data: png(10, 20, 30_000), filename: 'a.png' },
  { data: png(30, 40, 20_000), filename: 'b.png' },
]

// ---------------------------------------------------------------- session

type Method = 'SHIP' | 'MSHIP' | 'WRITEMEDIA' | 'FORWARD'
type Handler = (args: unknown[]) => LocoPacket | Promise<LocoPacket>

class FakeSession {
  readonly calls: { method: Method; args: unknown[] }[] = []
  private connection: object | null = {}
  constructor(private readonly script: Partial<Record<Method, Handler>> = {}) {}
  private async run(method: Method, args: unknown[]): Promise<LocoPacket> {
    this.calls.push({ method, args })
    const handler = this.script[method]
    if (!handler) throw new Error(`unexpected ${method}`)
    const reply = await handler(args)
    // The provider answers under the request's command name. The synthetic
    // close packet has none, and a test may name another command explicitly.
    return reply.method === '' && reply.body.error !== 'connection closed' ? { ...reply, method } : reply
  }
  shipMedia(...args: unknown[]) {
    return this.run('SHIP', args)
  }
  shipMultiMedia(...args: unknown[]) {
    return this.run('MSHIP', args)
  }
  writeMedia(body: Record<string, unknown>) {
    return this.run('WRITEMEDIA', [body])
  }
  forwardChat(...args: unknown[]) {
    return this.run('FORWARD', args)
  }
  getConnection() {
    return this.connection
  }
  close() {
    this.connection = null
  }
  count(method: Method) {
    return this.calls.filter((call) => call.method === method).length
  }
}

const FAST_IO: MediaIo = {
  trailerTiming: { connectMs: 3000, stallMs: 300, completeMs: 300 },
  directTiming: { requestMs: 5000, uploadStallMs: 5000, chunkMs: 15000, readyIntervalMs: 20, readyMaxWaitMs: 150 },
}

function fixture(session: FakeSession, io: MediaIo = {}) {
  const client = new KakaoTalkClient()
  let acquisitions = 0
  const internals = client as unknown as { state: { session: FakeSession } | null; closed: boolean }
  Object.assign(client, {
    oauthToken: TOKEN,
    userId: '4242',
    deviceUuid: DEVICE,
    deviceType: 'tablet',
    state: { session, loginResult: {} },
    mediaIo: { ...FAST_IO, ...io },
    ensureSession: async () => {
      acquisitions++
      if (internals.closed) throw new KakaoTalkError('Client is closed', 'client_closed')
      return internals.state
    },
  })
  return {
    client,
    acquisitions: () => acquisitions,
    replaceSession: (next: FakeSession) => Object.assign(client, { state: { session: next, loginResult: {} } }),
  }
}

const SECRETS = [TOKEN, DEVICE, ROOM, UPLOAD_KEY, 'kage.talk', 'talk-pilsner', 'credential', 'server-file', 'report']

// A thrown send carries its code and the two safe diagnostics, and nothing
// that names the account, room, file, ticket or upload URL.
async function rejects(
  send: Promise<unknown>,
  code: string,
  phase: string | string[],
  providerStatus: number | null = null,
): Promise<void> {
  await assert.rejects(send, (error: unknown) => {
    assert.ok(error instanceof KakaoTalkError, `expected KakaoTalkError, got ${String(error)}`)
    assert.equal(error.code, code)
    assert.ok(([] as string[]).concat(phase).includes(String(error.phase)), `phase ${error.phase}`)
    assert.equal(error.providerStatus, providerStatus)
    assert.equal(error.cause, undefined)
    for (const secret of SECRETS) assert.equal(error.message.includes(secret), false, error.message)
    return true
  })
}

const rejected = (statusCode: number) => ({
  success: false,
  status_code: statusCode,
  chat_id: ROOM,
  log_id: '0',
  sent_at: 0,
})

// ------------------------------------------------------- LOCO media server

interface MediaScript {
  /**
   * The POST answer. `close` drops the connection instead of answering,
   * `complete` pushes COMPLETE and never answers the POST, and
   * `complete-as-reply` answers the POST's packet id with COMPLETE.
   */
  post?:
    | { statusCode?: number; body?: Record<string, unknown>; method?: string }
    | 'close'
    | 'complete'
    | 'complete-as-reply'
  /** null withholds COMPLETE. */
  complete?: { statusCode?: number; body?: Record<string, unknown> } | null
  /** Stop reading once this many stream bytes (as encrypted) arrived. */
  stopReadingAfter?: number
  /** Drop the connection once this many stream bytes (as encrypted) arrived. */
  destroyAfter?: number
  /** Read no faster than this, by pausing after every received chunk. */
  bytesPerSecond?: number
  /** Called with the stream bytes (as encrypted) received so far. */
  onFileBytes?: (received: number) => void
}

interface MediaUpload {
  post: LocoPacket | null
  /** Plaintext size of every secure frame after POST. */
  frames: number[]
  hash: ReturnType<typeof createHash>
  received: number
}

// Speaks the client's real framing: a 268-byte handshake, then
// [size][nonce][ciphertext+tag] frames. The handshake's RSA-wrapped key cannot
// be opened here, so each client connection hands its AES key over directly.
class FakeMediaServer {
  readonly uploads: MediaUpload[] = []
  private readonly clients: LocoConnection[] = []
  private readonly keys = new Map<number, Buffer>()
  private readonly sockets = new Set<Socket>()
  private readonly pending = new Map<number, () => void>()
  private constructor(
    private readonly server: TcpServer,
    private readonly script: MediaScript,
  ) {}

  static async start(script: MediaScript = {}): Promise<FakeMediaServer> {
    const server = createTcpServer()
    const fake = new FakeMediaServer(server, script)
    server.on('connection', (socket) => fake.accept(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return fake
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port
  }

  /** Every media connection the SDK opened here has been closed by the SDK. */
  get clientsClosed(): boolean {
    return this.clients.every((client) => (client as unknown as { socket: Socket | null }).socket === null)
  }

  /** The media connection seam: a real LocoConnection that shares its key. */
  readonly createConnection = (): LocoConnection => {
    const share = (port: number, key: Buffer) => {
      this.keys.set(port, key)
      this.pending.get(port)?.()
    }
    const client = new (class extends LocoConnection {
      override async connectSecure(host: string, port: number): Promise<void> {
        await super.connectSecure(host, port)
        const own = this as unknown as { crypto: { aesKey: Buffer }; socket: Socket }
        share(own.socket.localPort!, own.crypto.aesKey)
      }
    })()
    this.clients.push(client)
    return client
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    const upload: MediaUpload = { post: null, frames: [], hash: createHash('sha1'), received: 0 }
    this.uploads.push(upload)
    const script = this.script
    // Received bytes are kept as a list and joined once per frame: the file
    // arrives as one frame of up to 16 MiB.
    let parts: Buffer[] = []
    let buffered = 0
    let total = 0
    let streamStart = -1
    let handshaken = false
    let expected = 0
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const take = (size: number): Buffer => {
      const all = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
      parts = [all.subarray(size)]
      buffered -= size
      return all.subarray(0, size)
    }
    const send = (crypto: LocoCrypto, reply: LocoPacket) => socket.write(crypto.encrypt(encodePacket(reply)))
    const complete = (crypto: LocoCrypto, packetId = 0x7fffffff) => {
      if (script.complete === null) return
      send(crypto, {
        packetId,
        statusCode: script.complete?.statusCode ?? 0,
        method: 'COMPLETE',
        bodyType: 0,
        body: script.complete?.body ?? {
          chatLog: { chatId: Long.fromString(ROOM), logId: Long.fromString(LOG), sendAt: 1700000001 },
        },
      })
    }
    const process = () => {
      const key = this.keys.get(socket.remotePort!)
      if (!key) return
      const crypto = new LocoCrypto(key)
      if (!handshaken) {
        if (buffered < 268) return
        take(268)
        handshaken = true
      }
      while (buffered >= 4 && !socket.destroyed) {
        if (parts[0]!.length < 4) parts = [Buffer.concat(parts)]
        const size = parts[0]!.readUInt32LE(0)
        if (buffered < 4 + size) return
        const plain = crypto.decrypt(take(4 + size).subarray(4))
        if (!upload.post) {
          upload.post = decodePacket(plain)!.packet
          streamStart = total - buffered
          if (script.post === 'close') {
            socket.destroy()
            return
          }
          if (script.post === 'complete' || script.post === 'complete-as-reply') {
            complete(crypto, script.post === 'complete' ? undefined : upload.post.packetId)
            continue
          }
          const body = script.post?.body ?? {}
          const statusCode = script.post?.statusCode ?? 0
          const method = script.post?.method ?? upload.post.method
          send(crypto, { packetId: upload.post.packetId, statusCode, method, bodyType: 0, body })
          expected = (upload.post.body.s as number) - ((body.o as number | undefined) ?? 0)
          if (statusCode === 0 && !body.status && expected === 0) complete(crypto)
          continue
        }
        upload.frames.push(plain.length)
        upload.hash.update(plain)
        upload.received += plain.length
        if (upload.received === expected) complete(crypto)
      }
    }
    this.pending.set(socket.remotePort!, process)
    socket.on('data', (chunk: Buffer) => {
      parts.push(chunk)
      buffered += chunk.length
      total += chunk.length
      process()
      if (socket.destroyed || streamStart < 0) return
      const stream = total - streamStart
      script.onFileBytes?.(stream)
      if (script.destroyAfter !== undefined && stream >= script.destroyAfter) {
        socket.destroy()
      } else if (script.stopReadingAfter !== undefined && stream >= script.stopReadingAfter) {
        stopped = true
        socket.pause()
      } else if (script.bytesPerSecond && !stopped) {
        socket.pause()
        timer = setTimeout(() => socket.resume(), (chunk.length * 1000) / script.bytesPerSecond)
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (timer) clearTimeout(timer)
      this.sockets.delete(socket)
    })
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

async function closedPort(): Promise<number> {
  const server = await FakeMediaServer.start()
  const { port } = server
  await server.close()
  return port
}

const tickets = (ports: number[]) =>
  packet({ status: 0, kl: ports.map((_, i) => `synthetic-${i}`), vhl: ports.map(() => '127.0.0.1'), pl: ports })
const ticketReply = (port: number, extra: Record<string, unknown> = {}) =>
  packet({ status: 0, k: 'synthetic-ticket', vh: '127.0.0.1', p: port, ...extra })

// ------------------------------------------------------------- HTTP server

interface HttpAnswer {
  status?: number
  json?: unknown
  text?: string
}
interface ChunkPart {
  offset: string
  filename: string
  contentType: string
  bytes: number
}
interface HttpScript {
  prepare?: (body: Record<string, unknown>) => HttpAnswer | 'drop'
  chunk?: (index: number, part: ChunkPart, defaults: HttpAnswer) => HttpAnswer | 'drop'
  ready?: (index: number, body: Record<string, unknown>) => HttpAnswer | Promise<HttpAnswer>
  /** Fields merged into the default prepared ticket. */
  ticket?: Record<string, unknown>
  /** Read an upload's body no faster than this. */
  uploadBytesPerSecond?: number
  /** Stop reading an upload's body once this many bytes arrived. */
  uploadStopReadingAfter?: number
}
interface HttpRequest {
  host: string
  path: string
  headers: IncomingHttpHeaders
  text: string
}

function multipart(
  body: Buffer,
  contentType: string,
): { offset: string; filename: string; contentType: string; data: Buffer } {
  const boundary = /boundary=(.+)$/.exec(contentType)![1]!
  const sections = body.toString('latin1').split(`--${boundary}`)
  assert.equal(sections.length, 4, 'offset, file_1 and the closing boundary')
  assert.equal(sections[3], '--\r\n')
  const [offsetHead, offsetValue] = sections[1]!.slice(2, -2).split('\r\n\r\n')
  assert.equal(offsetHead, 'Content-Disposition: form-data; name="offset"')
  const fileSplit = sections[2]!.indexOf('\r\n\r\n')
  const fileHead = sections[2]!.slice(2, fileSplit).split('\r\n')
  const named = /^Content-Disposition: form-data; name="file_1"; filename="([^"]+)"$/.exec(fileHead[0]!)
  assert.ok(named, 'file_1 follows offset')
  return {
    offset: offsetValue!,
    filename: named[1]!,
    contentType: fileHead[1]!.replace('Content-Type: ', ''),
    data: Buffer.from(sections[2]!.slice(fileSplit + 4, -2), 'latin1'),
  }
}

class FakeHttp {
  readonly requests: HttpRequest[] = []
  readonly chunks: ChunkPart[] = []
  readonly readyBodies: Record<string, unknown>[] = []
  readonly hash = createHash('sha1')
  private size = 0
  private received = 0
  private constructor(
    private readonly server: HttpServer,
    private readonly script: HttpScript,
  ) {}

  static async start(script: HttpScript = {}): Promise<FakeHttp> {
    const server = createHttpServer()
    const fake = new FakeHttp(server, script)
    server.on('request', (request, response) => {
      const parts: Buffer[] = []
      let size = 0
      const upload = request.url!.startsWith('/offset-up/')
      request.on('data', (part: Buffer) => {
        parts.push(part)
        size += part.length
        if (!upload) return
        if (script.uploadStopReadingAfter !== undefined && size >= script.uploadStopReadingAfter) {
          request.pause()
        } else if (script.uploadBytesPerSecond) {
          request.pause()
          setTimeout(() => request.resume(), (part.length * 1000) / script.uploadBytesPerSecond)
        }
      })
      request.on('end', async () => {
        const answer = await fake.answer(
          String(request.headers['x-test-host']),
          request.url!,
          request.headers,
          Buffer.concat(parts),
        )
        if (answer === 'drop') {
          request.socket.destroy()
          return
        }
        if (response.destroyed) return
        response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
        response.end(answer.text ?? JSON.stringify(answer.json ?? {}))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return fake
  }

  // The fetch seam: only the two Kakao hosts are accepted, and both are
  // answered by this local server. Everything else about the request is real.
  readonly fetch = (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    assert.ok(['talk-pilsner.kakao.com', 'kage.talk.kakao.com'].includes(url.host), `unexpected host ${url.host}`)
    assert.equal(url.protocol, 'https:')
    const { port } = this.server.address() as AddressInfo
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'x-test-host': url.host },
    })
  }

  private answer(
    host: string,
    path: string,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): HttpAnswer | 'drop' | Promise<HttpAnswer> {
    const request: HttpRequest = {
      host,
      path,
      headers,
      text: path.startsWith('/offset-up/') ? '' : body.toString('utf8'),
    }
    this.requests.push(request)
    if (path === '/messaging/files/v1/prepare') {
      const parsed = JSON.parse(request.text) as Record<string, unknown>
      this.size = parsed.size as number
      return (
        this.script.prepare?.(parsed) ?? {
          json: {
            url: SIGNED_URL,
            resource: RESOURCE,
            resourceType: 'vk',
            uploadKey: UPLOAD_KEY,
            chunkSize: CHUNK,
            needReady: false,
            ...this.script.ticket,
          },
        }
      )
    }
    if (path === '/messaging/files/v1/ready') {
      const parsed = JSON.parse(request.text) as Record<string, unknown>
      this.readyBodies.push(parsed)
      return this.script.ready?.(this.readyBodies.length - 1, parsed) ?? { json: { status: 1 } }
    }
    assert.ok(path.startsWith('/offset-up/synthetic/ready/?credential=synthetic'), path)
    const part = multipart(body, String(headers['content-type']))
    const chunk: ChunkPart = {
      offset: part.offset,
      filename: part.filename,
      contentType: part.contentType,
      bytes: part.data.length,
    }
    this.chunks.push(chunk)
    this.hash.update(part.data)
    this.received = Number(part.offset) + part.data.length
    const defaults: HttpAnswer =
      this.received === this.size
        ? { json: { msg: 'ok', info: [{ filename: 'server-file.dat', length: this.size, content_type: 'image' }] } }
        : { json: { offset: String(this.received), msg: 'ok' } }
    return this.script.chunk?.(this.chunks.length - 1, chunk, defaults) ?? defaults
  }

  paths(): string[] {
    return this.requests.map((request) => request.path.split('?')[0]!)
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

const redirect = () => packet({ status: 0, rd: true, k: '', vh: '', p: 0 })
const written = (extra: Record<string, unknown> = {}) =>
  packet({ status: 0, chatId: Long.fromString(ROOM), logId: Long.fromString(LOG), sendAt: 1700000002, ...extra })

function wire(body: Record<string, unknown>): Record<string, any> {
  const bytes = encodePacket({ ...packet(body), method: 'WRITEMEDIA' })
  return BSON.deserialize(bytes.subarray(22), { promoteValues: false })
}

// ============================================================ SHIP answers

test('SHIP refused in the header returns the provider status and uploads nothing', async () => {
  const session = new FakeSession({ SHIP: () => packet({}, -402) })
  const f = fixture(session, { createConnection: () => assert.fail('no media connection') })
  assert.deepEqual(await f.client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat'), rejected(-402))
  assert.equal(session.count('SHIP'), 1)
  assert.equal(f.acquisitions(), 1)
})

test('SHIP refused in body.status returns that status', async () => {
  const session = new FakeSession({ SHIP: () => packet({ status: -203 }) })
  const f = fixture(session, { createConnection: () => assert.fail('no media connection') })
  assert.deepEqual(await f.client.sendVideo(ROOM, Buffer.from('synthetic'), 'clip.mp4'), rejected(-203))
  assert.deepEqual(await f.client.sendPhoto(ROOM, png(2, 3), 'image.png'), rejected(-203))
  assert.deepEqual(await f.client.sendAudio(ROOM, Buffer.from('synthetic'), 'voice.m4a'), rejected(-203))
})

test('a SHIP answered by the closed connection is not a refusal: nothing was dispatched', async () => {
  const session = new FakeSession({ SHIP: closedPacket })
  const f = fixture(session, { createConnection: () => assert.fail('no media connection') })
  await rejects(f.client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat'), 'media_not_dispatched', 'ship')
  assert.equal(session.count('SHIP'), 1)
})

for (const [name, reply] of [
  ['non-integer header status', packet({}, Number.NaN)],
  ['fractional header status', packet({}, 1.5)],
  ['string body status', packet({ status: '-1' })],
  ['missing ticket', packet({ status: 0 })],
  ['empty ticket without redirect', packet({ status: 0, k: '', vh: '', p: 0 })],
  ['port out of range', packet({ status: 0, k: 'k', vh: '127.0.0.1', p: 70000 })],
  ['redirect of the wrong type', packet({ status: 0, rd: 'true', k: 'k', vh: '127.0.0.1', p: 1 })],
] as const) {
  test(`malformed SHIP (${name}) is not dispatched and never success:false`, async () => {
    const session = new FakeSession({ SHIP: () => reply })
    const f = fixture(session, { createConnection: () => assert.fail('no media connection') })
    await rejects(f.client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat'), 'media_not_dispatched', 'ship')
  })
}

test('a lost SHIP request and an unsupported photo are not dispatched', async () => {
  const session = new FakeSession({
    SHIP: () => {
      throw new Error(`timeout for ${ROOM} ${TOKEN}`)
    },
  })
  const f = fixture(session)
  await rejects(f.client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat'), 'media_not_dispatched', 'ship')
  await rejects(f.client.sendPhoto(ROOM, Buffer.from('not an image'), 'report.png'), 'media_not_dispatched', 'ship')
  assert.equal(session.count('SHIP'), 1)
  await rejects(f.client.sendMultiPhoto(ROOM, [{ data: png(1, 1) }]), 'media_not_dispatched', 'ship')
})

test('a send cancelled before SHIP dispatches nothing', async () => {
  const session = new FakeSession()
  const f = fixture(session)
  const controller = new AbortController()
  controller.abort()
  await rejects(
    f.client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat', undefined, { signal: controller.signal }),
    'media_not_dispatched',
    'ship',
  )
  assert.equal(session.count('SHIP'), 0)
  // Neither the file is hashed for a session nor a session acquired.
  assert.equal(f.acquisitions(), 0)
  await rejects(f.client.sendMultiPhoto(ROOM, photos(), { signal: controller.signal }), 'media_not_dispatched', 'ship')
  assert.equal(f.acquisitions(), 0)
})

test('a client that is not logged in dispatches nothing and acquires no session', async () => {
  const client = new KakaoTalkClient()
  let acquisitions = 0
  Object.assign(client, {
    ensureSession: async () => {
      acquisitions++
      throw new Error('unreachable')
    },
  })
  await rejects(client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat'), 'media_not_dispatched', 'ship')
  await rejects(client.sendPhoto(ROOM, png(2, 3), 'image.png'), 'media_not_dispatched', 'ship')
  await rejects(client.sendMultiPhoto(ROOM, photos()), 'media_not_dispatched', 'ship')
  assert.equal(acquisitions, 0)
})

test('a session that cannot be acquired dispatches nothing', async () => {
  const session = new FakeSession()
  const f = fixture(session)
  Object.assign(f.client, {
    ensureSession: async () => {
      throw new KakaoTalkError(`login failed for ${TOKEN}`, 'login_failed')
    },
  })
  await rejects(f.client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat'), 'media_not_dispatched', 'ship')
  await rejects(f.client.sendMultiPhoto(ROOM, photos()), 'media_not_dispatched', 'ship')
  assert.equal(session.calls.length, 0)
})

// ============================================================ trailer path

test('trailer: streams the file as the one secure frame it has always been and registers on COMPLETE', async () => {
  const media = await FakeMediaServer.start()
  try {
    const data = randomBytes(1_000_003)
    const session = new FakeSession({ SHIP: () => ticketReply(media.port) })
    const f = fixture(session, { createConnection: media.createConnection })
    const result = await f.client.sendFile(ROOM, data, 'report.dat')
    assert.deepEqual(result, { success: true, status_code: 0, chat_id: ROOM, log_id: LOG, sent_at: 1700000001 })
    const [upload] = media.uploads
    assert.equal(upload!.post!.method, 'POST')
    assert.equal(upload!.post!.body.k, 'synthetic-ticket')
    assert.equal(upload!.post!.body.s, data.length)
    assert.equal(upload!.post!.body.f, 'report.dat')
    assert.equal(upload!.hash.digest('hex'), sha1(data))
    // The framing on the wire is unchanged: the whole file is one frame.
    assert.deepEqual(upload!.frames, [data.length])
    assert.deepEqual(session.calls[0]!.args.slice(1), [18, data.length, sha1(data).toUpperCase(), 'dat'])
  } finally {
    await media.close()
  }
})

for (const [name, size] of [
  ['9.4 MB', SIZE_9_4_MB],
  ['the 16 MiB limit', SIZE_LIMIT],
] as const) {
  test(`trailer: ${name} arrives byte-identical as one secure frame`, async () => {
    const media = await FakeMediaServer.start()
    try {
      const data = randomBytes(size)
      const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
        createConnection: media.createConnection,
      })
      const result = await f.client.sendVideo(ROOM, data, 'clip.mp4')
      assert.equal(result.success, true)
      const [upload] = media.uploads
      assert.equal(upload!.received, size)
      assert.equal(upload!.hash.digest('hex'), sha1(data))
      assert.deepEqual(upload!.frames, [size])
    } finally {
      await media.close()
    }
  })
}

test('trailer: the server offset is honoured, and a full offset still waits for COMPLETE', async () => {
  const data = randomBytes(100_000)
  for (const offset of [70_000, data.length]) {
    const media = await FakeMediaServer.start({ post: { body: { o: offset } } })
    try {
      const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
        createConnection: media.createConnection,
      })
      assert.equal((await f.client.sendFile(ROOM, data, 'report.dat')).success, true)
      assert.equal(media.uploads[0]!.received, data.length - offset)
      assert.equal(media.uploads[0]!.hash.digest('hex'), sha1(data.subarray(offset)))
    } finally {
      await media.close()
    }
  }
})

test('trailer: a media server that cannot be reached dispatched nothing', async () => {
  const session = new FakeSession({ SHIP: async () => ticketReply(await closedPort()) })
  const f = fixture(session, { createConnection: () => new LocoConnection() })
  await rejects(f.client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat'), 'media_not_dispatched', 'connect')
})

test('trailer: a refused POST returns the status before any file byte', async () => {
  for (const [post, expected] of [
    [{ statusCode: -500 }, -500],
    [{ body: { status: -501 } }, -501],
  ] as const) {
    const media = await FakeMediaServer.start({ post })
    try {
      const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
        createConnection: media.createConnection,
      })
      assert.deepEqual(await f.client.sendFile(ROOM, randomBytes(50_000), 'report.dat'), rejected(expected))
      assert.equal(media.uploads[0]!.received, 0)
    } finally {
      await media.close()
    }
  }
})

test('trailer: a lost POST answer or an invalid offset is outcome-unknown, never not-dispatched', async () => {
  // The server can answer a POST with COMPLETE alone when it already holds
  // every byte, so a single upload is open from the POST on.
  for (const post of ['close', { body: { o: 50_001 } }, { body: { o: -1 } }, { body: { o: 1.5 } }] as const) {
    const media = await FakeMediaServer.start({ post })
    try {
      const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
        createConnection: media.createConnection,
      })
      await rejects(f.client.sendFile(ROOM, randomBytes(50_000), 'report.dat'), 'send_file_failed', 'post')
      assert.equal(media.uploads[0]!.received, 0)
    } finally {
      await media.close()
    }
  }
})

test('trailer: a COMPLETE that arrives while the POST answer is lost registers the message', async () => {
  for (const post of ['complete', 'complete-as-reply'] as const) {
    const media = await FakeMediaServer.start({ post })
    try {
      const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
        createConnection: media.createConnection,
      })
      const result = await f.client.sendFile(ROOM, randomBytes(50_000), 'report.dat')
      assert.deepEqual(result, { success: true, status_code: 0, chat_id: ROOM, log_id: LOG, sent_at: 1700000001 })
      assert.equal(media.uploads[0]!.received, 0)
    } finally {
      await media.close()
    }
  }
})

test('trailer: a POST refusal that names a stored message, or a COMPLETE for another chat, is unknown', async () => {
  const contradicted = await FakeMediaServer.start({
    post: { statusCode: -500, body: { logId: Long.fromString(LOG) } },
  })
  const elsewhere = await FakeMediaServer.start({
    complete: { body: { chatLog: { chatId: Long.fromString('5'), logId: Long.fromString(LOG), sendAt: 1 } } },
  })
  try {
    const a = fixture(new FakeSession({ SHIP: () => ticketReply(contradicted.port) }), {
      createConnection: contradicted.createConnection,
    })
    await rejects(a.client.sendFile(ROOM, randomBytes(50_000), 'report.dat'), 'send_file_failed', 'post', -500)
    const b = fixture(new FakeSession({ SHIP: () => ticketReply(elsewhere.port) }), {
      createConnection: elsewhere.createConnection,
    })
    await rejects(b.client.sendFile(ROOM, randomBytes(50_000), 'report.dat'), 'send_file_failed', 'complete')
  } finally {
    await contradicted.close()
    await elsewhere.close()
  }
})

test('trailer: a connection dropped mid-stream is outcome-unknown, never success:false', async () => {
  const media = await FakeMediaServer.start({ destroyAfter: 64 * 1024 })
  try {
    const session = new FakeSession({ SHIP: () => ticketReply(media.port) })
    const f = fixture(session, { createConnection: media.createConnection })
    await rejects(f.client.sendFile(ROOM, randomBytes(SIZE_LIMIT), 'report.dat'), 'send_file_failed', [
      'stream',
      'complete',
    ])
    assert.equal(session.count('SHIP'), 1)
  } finally {
    await media.close()
  }
})

test('trailer: a stream that stops making progress fails as unknown at the stall limit', async () => {
  const media = await FakeMediaServer.start({ stopReadingAfter: MIB })
  try {
    const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
      createConnection: media.createConnection,
    })
    await rejects(f.client.sendFile(ROOM, randomBytes(SIZE_LIMIT), 'report.dat'), 'send_file_failed', 'stream')
    assert.equal(media.clientsClosed, true)
  } finally {
    await media.close()
  }
})

test('trailer: cancelling mid-stream closes the media connection and stays unknown', async () => {
  const controller = new AbortController()
  const media = await FakeMediaServer.start({
    stopReadingAfter: MIB,
    onFileBytes: (received) => {
      if (received >= MIB) controller.abort()
    },
  })
  try {
    const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
      createConnection: media.createConnection,
      trailerTiming: { connectMs: 3000, stallMs: 30_000, completeMs: 30_000 },
    })
    await rejects(
      f.client.sendVideo(ROOM, randomBytes(SIZE_LIMIT), 'clip.mp4', { signal: controller.signal }),
      'send_video_failed',
      'stream',
    )
    assert.equal(media.clientsClosed, true)
  } finally {
    await media.close()
  }
})

test('trailer: a missing COMPLETE is outcome-unknown, never success:false', async () => {
  const media = await FakeMediaServer.start({ complete: null })
  try {
    const data = randomBytes(50_000)
    const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
      createConnection: media.createConnection,
    })
    await rejects(f.client.sendFile(ROOM, data, 'report.dat'), 'send_file_failed', 'complete')
    assert.equal(media.uploads[0]!.received, data.length)
  } finally {
    await media.close()
  }
})

test('trailer: COMPLETE with only an explicit status is a refusal; anything less clear is unknown', async () => {
  const refused = await FakeMediaServer.start({ complete: { statusCode: -910, body: {} } })
  const empty = await FakeMediaServer.start({ complete: { body: { status: 0 } } })
  const contradicted = await FakeMediaServer.start({
    complete: { statusCode: -910, body: { chatLog: { logId: Long.fromString(LOG), sendAt: 1 } } },
  })
  try {
    const a = fixture(new FakeSession({ SHIP: () => ticketReply(refused.port) }), {
      createConnection: refused.createConnection,
    })
    assert.deepEqual(await a.client.sendFile(ROOM, randomBytes(50_000), 'report.dat'), rejected(-910))
    const b = fixture(new FakeSession({ SHIP: () => ticketReply(empty.port) }), {
      createConnection: empty.createConnection,
    })
    await rejects(b.client.sendFile(ROOM, randomBytes(50_000), 'report.dat'), 'send_file_failed', 'complete')
    const c = fixture(new FakeSession({ SHIP: () => ticketReply(contradicted.port) }), {
      createConnection: contradicted.createConnection,
    })
    await rejects(c.client.sendFile(ROOM, randomBytes(50_000), 'report.dat'), 'send_file_failed', 'complete', -910)
  } finally {
    await refused.close()
    await empty.close()
    await contradicted.close()
  }
})

test('SHIP, MSHIP, POST and MPOST answers are matched by packet id alone, as before', async () => {
  // Whether the provider echoes these command names is not established, so
  // an answer under another name must not fail a send that worked before.
  const media = await FakeMediaServer.start({ post: { method: 'OTHER' } })
  const album = await FakeMediaServer.start({ post: { method: '' }, complete: { body: { status: 0 } } })
  try {
    const data = randomBytes(50_000)
    const single = fixture(new FakeSession({ SHIP: () => ({ ...ticketReply(media.port), method: 'OTHER' }) }), {
      createConnection: media.createConnection,
    })
    assert.equal((await single.client.sendPhoto(ROOM, png(4, 4, 50_000), 'image.png')).log_id, LOG)
    assert.equal((await single.client.sendFile(ROOM, data, 'report.dat')).log_id, LOG)
    assert.equal(media.uploads[1]!.hash.digest('hex'), sha1(data))

    const multi = fixture(
      new FakeSession({
        MSHIP: () => ({ ...tickets([album.port, album.port]), method: 'OTHER' }),
        FORWARD: () => packet({ status: 0, logId: Long.fromString(LOG), sendAt: 5 }),
      }),
      { createConnection: album.createConnection },
    )
    assert.equal((await multi.client.sendMultiPhoto(ROOM, photos())).log_id, LOG)
  } finally {
    await media.close()
    await album.close()
  }
})

test('trailer: a COMPLETE that states another chat or two different messages is unknown', async () => {
  const here = Long.fromString(ROOM)
  const log = Long.fromString(LOG)
  for (const body of [
    { chatId: Long.fromString('5'), chatLog: { chatId: here, logId: log, sendAt: 1 } },
    { chatId: here, chatLog: { chatId: Long.fromString('5'), logId: log, sendAt: 1 } },
    { logId: Long.fromString('999'), chatLog: { chatId: here, logId: log, sendAt: 1 } },
  ]) {
    const media = await FakeMediaServer.start({ complete: { body } })
    try {
      const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
        createConnection: media.createConnection,
      })
      await rejects(f.client.sendFile(ROOM, randomBytes(50_000), 'report.dat'), 'send_file_failed', 'complete')
    } finally {
      await media.close()
    }
  }
})

test('trailer: a COMPLETE without sendAt is still a registered message, as before', async () => {
  const media = await FakeMediaServer.start({ complete: { body: { chatLog: { logId: Long.fromString(LOG) } } } })
  try {
    const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
      createConnection: media.createConnection,
    })
    assert.deepEqual(await f.client.sendPhoto(ROOM, png(2, 3, 5000), 'image.png'), {
      success: true,
      status_code: 0,
      chat_id: ROOM,
      log_id: LOG,
      sent_at: 0,
    })
  } finally {
    await media.close()
  }
})

test('trailer: a chat id the caller wrote differently is compared as the provider writes it', async () => {
  const media = await FakeMediaServer.start({
    complete: { body: { chatLog: { chatId: Long.fromString(ROOM), logId: Long.fromString(LOG) } } },
  })
  try {
    const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
      createConnection: media.createConnection,
    })
    // The same chat with a leading zero: the request names it as the provider
    // does, so its own answer is not read as another chat's.
    const result = await f.client.sendPhoto('0' + ROOM, png(2, 3, 5000), 'image.png')
    assert.equal(result.success, true)
    assert.equal(result.chat_id, '0' + ROOM)
    assert.equal(result.log_id, LOG)
  } finally {
    await media.close()
  }
})

test('trailer: a slow upload that keeps progressing outlives both timers and succeeds', async () => {
  // 3 MiB read at 4 MiB/s takes about 750 ms: longer than the 300 ms COMPLETE
  // wait and the 500 ms stall limit, neither of which may be measured from
  // the start of the upload.
  const media = await FakeMediaServer.start({ bytesPerSecond: 4 * MIB })
  try {
    const data = randomBytes(3 * MIB)
    const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
      createConnection: media.createConnection,
      trailerTiming: { connectMs: 3000, stallMs: 500, completeMs: 300 },
    })
    const started = Date.now()
    const result = await f.client.sendVideo(ROOM, data, 'clip.mp4')
    assert.equal(result.success, true)
    assert.ok(Date.now() - started > 600, `took ${Date.now() - started} ms`)
    assert.equal(media.uploads[0]!.hash.digest('hex'), sha1(data))
  } finally {
    await media.close()
  }
})

// ======================================================== reconnect rerun

test('rerun guard: after file bytes were streamed, a replaced session never sends again', async () => {
  const second = new FakeSession({ SHIP: () => packet({}, -402) })
  let replace = () => {}
  const media = await FakeMediaServer.start({ destroyAfter: 64 * 1024, onFileBytes: () => replace() })
  try {
    const first = new FakeSession({ SHIP: () => ticketReply(media.port) })
    const f = fixture(first, { createConnection: media.createConnection })
    replace = () => f.replaceSession(second)
    await rejects(f.client.sendFile(ROOM, randomBytes(SIZE_LIMIT), 'report.dat'), 'send_file_failed', [
      'stream',
      'complete',
    ])
    // The session was reacquired, but the refusal it would have answered is
    // never asked for: the first attempt may have registered the message.
    assert.equal(f.acquisitions(), 2)
    assert.equal(first.count('SHIP'), 1)
    assert.equal(second.count('SHIP'), 0)
    assert.equal(media.uploads.length, 1)
  } finally {
    await media.close()
  }
})

test('rerun: a session lost before anything was sent is still retried once, and its refusal is definite', async () => {
  const second = new FakeSession({ SHIP: () => packet({}, -402) })
  let replace = () => {}
  const first = new FakeSession({
    SHIP: () => {
      replace()
      return closedPacket()
    },
  })
  const f = fixture(first)
  replace = () => f.replaceSession(second)
  assert.deepEqual(await f.client.sendFile(ROOM, Buffer.from('synthetic'), 'report.dat'), rejected(-402))
  assert.equal(first.count('SHIP'), 1)
  assert.equal(second.count('SHIP'), 1)
})

// ======================================================= redirect (rd:true)

test('redirect: a file is prepared, uploaded to Kage and registered by one WRITEMEDIA', async () => {
  const http = await FakeHttp.start()
  try {
    const data = randomBytes(70_000)
    const session = new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() })
    const f = fixture(session, {
      fetch: http.fetch,
      createConnection: () => assert.fail('redirect dialed the trailer'),
    })
    const result = await f.client.sendFile(ROOM, data, 'Report Final.DAT')
    assert.deepEqual(result, { success: true, status_code: 0, chat_id: ROOM, log_id: LOG, sent_at: 1700000002 })
    assert.deepEqual(http.paths(), ['/messaging/files/v1/prepare', '/offset-up/synthetic/ready/'])

    const [prepare, upload] = http.requests
    // The chat id is beyond 2^53 and must reach the provider digit for digit.
    assert.equal(prepare!.text, `{"chatId":${ROOM},"mediaType":"file","size":70000,"extension":"dat"}`)
    assert.equal(prepare!.host, 'talk-pilsner.kakao.com')
    assert.equal(prepare!.headers.authorization, `${TOKEN}-${DEVICE}`)
    assert.equal(prepare!.headers.a, 'android/25.9.2/ko')
    assert.equal(prepare!.headers['user-agent'], 'KT/25.9.2 An/13 ko')
    assert.equal(prepare!.headers['content-type'], 'application/json;charset=UTF-8')
    assert.equal(prepare!.headers.accept, 'application/json')
    assert.equal(prepare!.headers['talk-agent'], 'android/25.9.2')
    assert.equal(prepare!.headers['talk-user-id'], '4242')
    assert.equal(prepare!.headers['talk-language'], 'ko')

    // The signed upload URL gets the client identity and no account credential.
    assert.equal(upload!.host, 'kage.talk.kakao.com')
    for (const header of ['authorization', 'cookie', 'talk-user-id', 'talk-agent', 'talk-language']) {
      assert.equal(upload!.headers[header], undefined, header)
    }
    assert.equal(JSON.stringify(upload!.headers).includes(TOKEN), false)
    assert.equal(upload!.headers.a, 'android/25.9.2/ko')
    assert.deepEqual(http.chunks, [
      { offset: '0', filename: 'server-file.dat', contentType: 'application/octet-stream', bytes: 70_000 },
    ])
    assert.equal(http.hash.digest('hex'), sha1(data))

    assert.equal(session.count('WRITEMEDIA'), 1)
    const body = wire(session.calls[1]!.args[0] as Record<string, unknown>)
    assert.deepEqual(Object.keys(body), ['chatId', 'msgId', 'scope', 'type', 'noSeen', 'noLight', 'silence', 'file'])
    assert.ok(body.chatId instanceof Long)
    assert.equal(body.chatId.toString(), ROOM)
    assert.ok(body.msgId instanceof Long)
    assert.ok(body.scope instanceof Int32 && body.scope.valueOf() === 1)
    assert.equal(body.type.valueOf(), 18)
    assert.deepEqual([body.noSeen, body.noLight, body.silence], [false, false, false])
    assert.deepEqual(body.file, {
      resource: RESOURCE,
      resourceType: 'vk',
      hfac: UPLOAD_KEY,
      name: 'Report Final.DAT',
      checksum: sha1(data),
    })
  } finally {
    await http.close()
  }
})

test('redirect: WRITEMEDIA accepts a consistent nested position with or without nested chatId', async () => {
  const http = await FakeHttp.start()
  try {
    for (const chatId of [undefined, Long.fromString(ROOM)]) {
      const session = new FakeSession({
        SHIP: redirect,
        WRITEMEDIA: () => packet({
          chatId: Long.fromString(ROOM),
          chatLog: { ...(chatId === undefined ? {} : { chatId }), logId: Long.fromString(LOG), sendAt: 1 },
        }),
      })
      const f = fixture(session, { fetch: http.fetch })
      assert.deepEqual(await f.client.sendFile(ROOM, randomBytes(1000), 'report.dat'), {
        success: true, status_code: 0, chat_id: ROOM, log_id: LOG, sent_at: 1,
      })
      assert.equal(session.count('WRITEMEDIA'), 1)
    }
  } finally {
    await http.close()
  }
})

test('redirect: a video waits for ready (5, then 1) before its WRITEMEDIA', async () => {
  const http = await FakeHttp.start({
    ticket: { resource: 'synthetic/bucket/object/server-file.mp4', needReady: true },
    chunk: () => ({ json: { msg: 'ok' } }),
    ready: (index) => ({ json: { status: index === 0 ? 5 : 1, interval: 10, maxWaitSeconds: 600 } }),
  })
  try {
    const data = randomBytes(17_281)
    const session = new FakeSession({
      SHIP: redirect,
      WRITEMEDIA: () => packet({ status: 0, chatId: Long.fromString(ROOM), chatLog: { logId: 7, sendAt: 9 } }),
    })
    const f = fixture(session, { fetch: http.fetch })
    const result = await f.client.sendVideo(ROOM, data, 'clip.MP4')
    assert.deepEqual(result, { success: true, status_code: 0, chat_id: ROOM, log_id: '7', sent_at: 9 })
    assert.equal(http.requests[0]!.text, `{"chatId":${ROOM},"mediaType":"video","size":17281,"extension":"mp4"}`)
    assert.deepEqual(http.chunks, [
      { offset: '0', filename: 'server-file.mp4', contentType: 'video/mp4', bytes: 17_281 },
    ])
    assert.equal(http.requests[2]!.text.startsWith(`{"chatId":${ROOM},`), true)
    assert.equal(http.requests[2]!.headers.authorization, `${TOKEN}-${DEVICE}`)
    assert.deepEqual(
      http.readyBodies.map((body) => [body.prevStatus, body.mediaType, body.resourceType, body.uploadKey, body.jobId]),
      [
        [0, 'video', 'vk', UPLOAD_KEY, undefined],
        [5, 'video', 'vk', UPLOAD_KEY, undefined],
      ],
    )
    const body = wire(session.calls[1]!.args[0] as Record<string, unknown>)
    assert.equal(body.type.valueOf(), 3)
    assert.deepEqual(body.video, {
      resource: 'synthetic/bucket/object/server-file.mp4',
      resourceType: 'vk',
      hfac: UPLOAD_KEY,
    })
    assert.equal('extra' in body, false)
  } finally {
    await http.close()
  }
})

test('redirect: a photo is prepared as an image and written with its dimensions', async () => {
  // A photo whose stored file the final acknowledgement does not identify
  // (here it names another file) is never written.
  const unconfirmed = await FakeHttp.start({ ticket: { resource: 'synthetic/bucket/object/server-file.png' } })
  try {
    const session = new FakeSession({ SHIP: redirect })
    const f = fixture(session, { fetch: unconfirmed.fetch })
    await rejects(f.client.sendPhoto(ROOM, png(640, 480, 2048), 'photo.png'), 'media_not_dispatched', 'upload')
    assert.equal(session.count('WRITEMEDIA'), 0)
  } finally {
    await unconfirmed.close()
  }

  const confirmed = await FakeHttp.start({
    ticket: { resource: 'synthetic/bucket/object/server-file.png' },
    chunk: () => ({
      json: { msg: 'ok', info: [{ filename: 'server-file.png', length: 2048, content_type: 'image' }] },
    }),
  })
  try {
    const session = new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() })
    const f = fixture(session, { fetch: confirmed.fetch })
    assert.equal((await f.client.sendPhoto(ROOM, png(640, 480, 2048), 'photo.png')).success, true)
    assert.equal(confirmed.requests[0]!.text, `{"chatId":${ROOM},"mediaType":"image","size":2048,"extension":"png"}`)
    assert.equal(confirmed.chunks[0]!.contentType, 'image/png')
    const body = wire(session.calls[1]!.args[0] as Record<string, unknown>)
    assert.equal(body.type.valueOf(), 2)
    assert.equal(body.photo.width.valueOf(), 640)
    assert.equal(body.photo.height.valueOf(), 480)
    assert.equal(body.photo.hfac, UPLOAD_KEY)
  } finally {
    await confirmed.close()
  }
})

for (const [name, size, offsets] of [
  ['9.4 MB', SIZE_9_4_MB, ['0', '4194304', '8388608']],
  ['one byte under the 16 MiB limit', SIZE_LIMIT - 1, ['0', '4194304', '8388608', '12582912']],
  ['the 16 MiB limit', SIZE_LIMIT, ['0', '4194304', '8388608', '12582912']],
] as const) {
  test(`redirect: ${name} is uploaded in ordered 4 MiB chunks, byte-identical`, async () => {
    const http = await FakeHttp.start()
    try {
      const data = randomBytes(size)
      const session = new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() })
      const f = fixture(session, { fetch: http.fetch })
      assert.equal((await f.client.sendFile(ROOM, data, 'report.dat')).success, true)
      assert.deepEqual(
        http.chunks.map((chunk) => chunk.offset),
        offsets,
      )
      assert.ok(http.chunks.slice(0, -1).every((chunk) => chunk.bytes === CHUNK))
      assert.equal(http.chunks.at(-1)!.bytes, size - CHUNK * (offsets.length - 1))
      assert.equal(http.hash.digest('hex'), sha1(data))
      assert.equal(session.count('WRITEMEDIA'), 1)
    } finally {
      await http.close()
    }
  })
}

test('redirect: a refused prepare returns the provider status and uploads nothing', async () => {
  for (const [answer, status] of [
    [{ status: 400, json: { code: '90008', reason: 'INVALID_REQUEST' } }, 90008],
    [{ status: 401, json: { reason: 'UNAUTHENTICATED', message: 'synthetic text' } }, 401],
    [{ status: 404, text: '404 Not Found' }, 404],
  ] as const) {
    const http = await FakeHttp.start({ prepare: () => answer })
    try {
      const session = new FakeSession({ SHIP: redirect })
      const f = fixture(session, { fetch: http.fetch })
      assert.deepEqual(await f.client.sendFile(ROOM, randomBytes(1000), 'report.dat'), rejected(status))
      assert.deepEqual(http.paths(), ['/messaging/files/v1/prepare'])
      assert.equal(session.count('WRITEMEDIA'), 0)
    } finally {
      await http.close()
    }
  }
})

test('trailer: closing the client mid-upload lets the media connection finish', async () => {
  let close = () => {}
  const media = await FakeMediaServer.start({ onFileBytes: () => close() })
  try {
    const data = randomBytes(MIB)
    const f = fixture(new FakeSession({ SHIP: () => ticketReply(media.port) }), {
      createConnection: media.createConnection,
    })
    close = () => f.client.close()
    assert.equal((await f.client.sendFile(ROOM, data, 'report.dat')).log_id, LOG)
    assert.equal(media.uploads[0]!.hash.digest('hex'), sha1(data))
  } finally {
    await media.close()
  }
})

test('redirect: a prepare that fails, is malformed or selects another strategy dispatches nothing', async () => {
  for (const prepare of [
    () => 'drop' as const,
    () => ({ text: 'not json' }),
    // A gateway failure is not the provider's refusal.
    () => ({ status: 502, text: 'error code: 502' }),
    () => ({ status: 302, text: '' }),
    () => ({
      json: { url: SIGNED_URL, resource: RESOURCE, resourceType: 'vk', uploadKey: UPLOAD_KEY, chunkSize: '4' },
    }),
    // Tenth is not implemented: it stops before any byte is uploaded.
    () => ({
      json: { url: SIGNED_URL, resource: RESOURCE, resourceType: 'vt', uploadKey: UPLOAD_KEY, chunkSize: CHUNK },
    }),
    () => ({ json: { url: SIGNED_URL, resource: RESOURCE, resourceType: 'vk', uploadKey: UPLOAD_KEY, chunkSize: 0 } }),
    () => ({
      json: {
        url: 'https://example.invalid/offset-up/x',
        resource: RESOURCE,
        resourceType: 'vk',
        uploadKey: UPLOAD_KEY,
        chunkSize: CHUNK,
      },
    }),
    () => ({
      json: {
        url: SIGNED_URL,
        resource: 'https://example.invalid/a.dat',
        resourceType: 'vk',
        uploadKey: UPLOAD_KEY,
        chunkSize: CHUNK,
      },
    }),
  ]) {
    const http = await FakeHttp.start({ prepare })
    try {
      const session = new FakeSession({ SHIP: redirect })
      const f = fixture(session, { fetch: http.fetch })
      await rejects(f.client.sendFile(ROOM, randomBytes(1000), 'report.dat'), 'media_not_dispatched', 'prepare')
      assert.deepEqual(http.paths(), ['/messaging/files/v1/prepare'])
      assert.equal(session.count('WRITEMEDIA'), 0)
    } finally {
      await http.close()
    }
  }
})

test('redirect: audio and a file without an extension have no HTTP form and are not dispatched', async () => {
  const http = await FakeHttp.start()
  try {
    const session = new FakeSession({ SHIP: redirect })
    const f = fixture(session, { fetch: http.fetch })
    await rejects(f.client.sendAudio(ROOM, randomBytes(1000), 'voice.m4a'), 'media_not_dispatched', 'prepare')
    await rejects(f.client.sendFile(ROOM, randomBytes(1000), 'README'), 'media_not_dispatched', 'prepare')
    assert.equal(http.requests.length, 0)
  } finally {
    await http.close()
  }
})

test('redirect: a failed middle chunk stops the upload before WRITEMEDIA', async () => {
  const data = randomBytes(CHUNK * 2 + 10)
  for (const [name, chunk, check] of [
    ['refused', () => ({ status: 404, json: { msg: 'Not found upload ready key.' } }), 'refused'],
    ['dropped', () => 'drop' as const, 'upload'],
    ['wrong offset', () => ({ json: { offset: '1', msg: 'ok' } }), 'upload'],
    ['not json', () => ({ text: '<html>' }), 'upload'],
  ] as const) {
    const http = await FakeHttp.start({ chunk: (index, _part, defaults) => (index === 1 ? chunk() : defaults) })
    try {
      const session = new FakeSession({ SHIP: redirect })
      const f = fixture(session, { fetch: http.fetch })
      const send = f.client.sendFile(ROOM, data, 'report.dat')
      if (check === 'refused') assert.deepEqual(await send, rejected(404), name)
      else await rejects(send, 'media_not_dispatched', 'upload')
      assert.deepEqual(
        http.chunks.map((part) => part.offset),
        ['0', String(CHUNK)],
        name,
      )
      assert.equal(session.count('WRITEMEDIA'), 0)
    } finally {
      await http.close()
    }
  }
})

test('redirect: the content filter (90025) on ready is a refusal without a write', async () => {
  const http = await FakeHttp.start({
    ticket: { needReady: true },
    chunk: () => ({ json: { msg: 'ok' } }),
    ready: () => ({ status: 400, json: { code: '90025', reason: 'ILLEGAL_CONTENT' } }),
  })
  try {
    const session = new FakeSession({ SHIP: redirect })
    const f = fixture(session, { fetch: http.fetch })
    assert.deepEqual(await f.client.sendVideo(ROOM, randomBytes(1000), 'clip.mp4'), rejected(90025))
    assert.equal(http.readyBodies.length, 1)
    assert.equal(session.count('WRITEMEDIA'), 0)
  } finally {
    await http.close()
  }
})

test('redirect: media that never becomes ready ends at the deadline without a write', async () => {
  const http = await FakeHttp.start({
    ticket: { needReady: true },
    chunk: () => ({ json: { msg: 'ok' } }),
    ready: () => ({ json: { status: 5, interval: 40, maxWaitSeconds: 0 } }),
  })
  try {
    const session = new FakeSession({ SHIP: redirect })
    const f = fixture(session, { fetch: http.fetch })
    await rejects(f.client.sendVideo(ROOM, randomBytes(1000), 'clip.mp4'), 'media_not_dispatched', 'ready')
    assert.ok(http.readyBodies.length >= 2 && http.readyBodies.length <= 5, `polls ${http.readyBodies.length}`)
    assert.equal(session.count('WRITEMEDIA'), 0)
  } finally {
    await http.close()
  }
})

test('redirect: a later ready answer cannot extend the deadline an earlier one set', async () => {
  const timing = { ...FAST_IO.directTiming, readyMaxWaitMs: 5000 }
  // The first answer allows 1 s in all; the second asks for 5 s and a 900 ms sleep.
  const extended = await FakeHttp.start({
    ticket: { needReady: true },
    chunk: () => ({ json: { msg: 'ok' } }),
    ready: (index) =>
      index === 0
        ? { json: { status: 5, interval: 300, maxWaitSeconds: 1 } }
        : { json: { status: index === 1 ? 5 : 1, interval: 900, maxWaitSeconds: 5 } },
  })
  // One answer that both shortens the deadline to 1 s and arrives after it.
  const late = await FakeHttp.start({
    ticket: { needReady: true },
    chunk: () => ({ json: { msg: 'ok' } }),
    ready: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
      return { json: { status: 1, maxWaitSeconds: 1 } }
    },
  })
  try {
    for (const http of [extended, late]) {
      const session = new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() })
      const f = fixture(session, { fetch: http.fetch, directTiming: timing })
      await rejects(f.client.sendVideo(ROOM, randomBytes(1000), 'clip.mp4'), 'media_not_dispatched', 'ready')
      assert.equal(session.count('WRITEMEDIA'), 0)
    }
    assert.equal(extended.readyBodies.length, 2)
    assert.equal(late.readyBodies.length, 1)
  } finally {
    await extended.close()
    await late.close()
  }
})

test('redirect: READY_DONE at the exact shortened deadline is not accepted', async () => {
  const priorNow = Object.getOwnPropertyDescriptor(performance, 'now')
  let now = 0
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  try {
    await assert.rejects(waitDirectReady({
      authorizedHeaders: {}, uploadHeaders: {},
      timing: { requestMs: 5000, readyMaxWaitMs: 5000 },
      fetch: async () => {
        now = 1000
        return new Response(JSON.stringify({ status: 1, maxWaitSeconds: 1 }))
      },
    }, ROOM, 'video', {
      url: SIGNED_URL, resource: RESOURCE, resourceType: 'vk', uploadKey: UPLOAD_KEY,
      filename: 'server-file.dat', chunkSize: CHUNK, needReady: true,
    }), (error: unknown) => {
      assert.ok(error instanceof MediaStepError)
      assert.equal(error.phase, 'ready')
      assert.equal(error.failure, 'timeout')
      return true
    })
  } finally {
    if (priorNow) Object.defineProperty(performance, 'now', priorNow)
    else Reflect.deleteProperty(performance, 'now')
  }
})

test('redirect: a ready answer that arrives after the deadline does not start WRITEMEDIA', async () => {
  const http = await FakeHttp.start({
    ticket: { needReady: true },
    chunk: () => ({ json: { msg: 'ok' } }),
    ready: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { json: { status: 1 } }
    },
  })
  try {
    const session = new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() })
    const f = fixture(session, { fetch: http.fetch, directTiming: { ...FAST_IO.directTiming, readyMaxWaitMs: 60 } })
    const started = Date.now()
    await rejects(f.client.sendVideo(ROOM, randomBytes(1000), 'clip.mp4'), 'media_not_dispatched', 'ready')
    assert.ok(Date.now() - started < 350, `took ${Date.now() - started} ms`)
    assert.equal(http.readyBodies.length, 1)
    assert.equal(session.count('WRITEMEDIA'), 0)
  } finally {
    await http.close()
  }
})

test('redirect: an answer that repeats a key is not acted on', async () => {
  const ticket = `"url":"${SIGNED_URL}","resource":"${RESOURCE}","uploadKey":"${UPLOAD_KEY}","chunkSize":${CHUNK}`
  for (const [script, phase] of [
    [{ prepare: () => ({ text: `{${ticket},"resourceType":"vt","resourceType":"vk"}` }) }, 'prepare'],
    [{ prepare: () => ({ text: `{${ticket},"resourceType":"vk","\\u0075rl":"${SIGNED_URL}"}` }) }, 'prepare'],
    [{ chunk: () => ({ text: '{"msg":"failed","msg":"ok"}' }) }, 'upload'],
    [{ ticket: { needReady: true }, ready: () => ({ text: '{"status":5,"status":1}' }) }, 'ready'],
  ] as const) {
    const http = await FakeHttp.start(script)
    try {
      const session = new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() })
      const f = fixture(session, { fetch: http.fetch })
      await rejects(f.client.sendFile(ROOM, randomBytes(1000), 'report.dat'), 'media_not_dispatched', phase)
      assert.equal(session.count('WRITEMEDIA'), 0)
    } finally {
      await http.close()
    }
  }

  // A nested object that repeats a key is refused too: a photo's final
  // acknowledgement is judged by its `info` entry.
  for (const key of ['filename', '\\u0066ilename']) {
    const entry = `"filename":"OTHER","${key}":"server-file.png","length":2048,"content_type":"image"`
    const photo = await FakeHttp.start({
      ticket: { resource: 'synthetic/bucket/object/server-file.png' },
      chunk: () => ({ text: `{"msg":"ok","info":[{${entry}}]}` }),
    })
    try {
      const session = new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() })
      const f = fixture(session, { fetch: photo.fetch })
      await rejects(f.client.sendPhoto(ROOM, png(640, 480, 2048), 'photo.png'), 'media_not_dispatched', 'upload')
      assert.equal(session.count('WRITEMEDIA'), 0)
    } finally {
      await photo.close()
    }
  }

  // Each object's own keys count: the same key in sibling objects or inside a
  // text that merely looks like one is not a repeat.
  const nested = `{${ticket},"resourceType":"vk","note":"{\\"url\\":1,\\"url\\":2}","extra":[{"url":1},{"url":2}]}`
  const http = await FakeHttp.start({ prepare: () => ({ text: nested }) })
  try {
    const f = fixture(new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() }), { fetch: http.fetch })
    assert.equal((await f.client.sendFile(ROOM, randomBytes(1000), 'report.dat')).success, true)
  } finally {
    await http.close()
  }
})

test('redirect: a slow Kage chunk that keeps progressing outlives both limits; a stalled one ends', async () => {
  // About 2 s for 2 MiB at 1 MiB/s: longer than the 1 s stall limit and the
  // 1.5 s wait for the acknowledgement, neither of which starts with the chunk.
  const slow = await FakeHttp.start({ uploadBytesPerSecond: MIB })
  try {
    const data = randomBytes(2 * MIB)
    const session = new FakeSession({ SHIP: redirect, WRITEMEDIA: () => written() })
    const f = fixture(session, {
      fetch: slow.fetch,
      directTiming: { ...FAST_IO.directTiming, uploadStallMs: 1000, chunkMs: 1500 },
    })
    const started = Date.now()
    assert.equal((await f.client.sendFile(ROOM, data, 'report.dat')).success, true)
    assert.ok(Date.now() - started > 1500, `took ${Date.now() - started} ms`)
    assert.equal(slow.hash.digest('hex'), sha1(data))
    // The streamed body carries its exact length, not chunked encoding.
    assert.equal(slow.requests[1]!.headers['transfer-encoding'], undefined)
    assert.ok(Number(slow.requests[1]!.headers['content-length']) > data.length)
  } finally {
    await slow.close()
  }

  const stalled = await FakeHttp.start({ ticket: { chunkSize: SIZE_LIMIT }, uploadStopReadingAfter: 256 * 1024 })
  try {
    const session = new FakeSession({ SHIP: redirect })
    const f = fixture(session, {
      fetch: stalled.fetch,
      directTiming: { ...FAST_IO.directTiming, uploadStallMs: 300, chunkMs: 15_000 },
    })
    const started = Date.now()
    await rejects(f.client.sendFile(ROOM, randomBytes(SIZE_LIMIT), 'report.dat'), 'media_not_dispatched', 'upload')
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
    assert.equal(session.count('WRITEMEDIA'), 0)
  } finally {
    await stalled.close()
  }
})

test('redirect: cancelling during the upload or the ready wait sends no WRITEMEDIA', async () => {
  for (const stage of ['upload', 'ready'] as const) {
    const controller = new AbortController()
    const http = await FakeHttp.start({
      ticket: { needReady: true },
      chunk: (index, _part, defaults) => {
        if (stage === 'upload' && index === 0) controller.abort()
        return defaults
      },
      ready: () => {
        controller.abort()
        return { json: { status: 5, interval: 20, maxWaitSeconds: 600 } }
      },
    })
    try {
      const session = new FakeSession({ SHIP: redirect })
      const f = fixture(session, { fetch: http.fetch })
      await rejects(
        f.client.sendVideo(ROOM, randomBytes(CHUNK + 10), 'clip.mp4', { signal: controller.signal }),
        'media_not_dispatched',
        stage,
      )
      assert.equal(session.count('WRITEMEDIA'), 0)
    } finally {
      await http.close()
    }
  }
})

test('redirect: a session already closed before WRITEMEDIA dispatched nothing', async () => {
  const http = await FakeHttp.start()
  try {
    const session = new FakeSession({ SHIP: redirect })
    const f = fixture(session, { fetch: http.fetch })
    const send = f.client.sendFile(ROOM, randomBytes(1000), 'report.dat')
    session.close()
    await rejects(send, 'media_not_dispatched', 'write')
    assert.equal(session.count('WRITEMEDIA'), 0)
  } finally {
    await http.close()
  }
})

test('redirect: closing the client ends the HTTP upload without a write', async () => {
  let close = () => {}
  const http = await FakeHttp.start({
    chunk: (index, _part, defaults) => {
      if (index === 0) close()
      return defaults
    },
  })
  try {
    const session = new FakeSession({ SHIP: redirect })
    const f = fixture(session, { fetch: http.fetch })
    close = () => f.client.close()
    await rejects(f.client.sendFile(ROOM, randomBytes(CHUNK * 2), 'report.dat'), 'media_not_dispatched', 'upload')
    assert.equal(http.chunks.length, 1)
    assert.equal(session.count('WRITEMEDIA'), 0)
  } finally {
    await http.close()
  }
})

const stored = { chatId: Long.fromString(ROOM), logId: Long.fromString(LOG), sendAt: 1700000002 }

// No WRITEMEDIA status is known to prove that nothing was stored, so every
// answer short of a consistent success leaves the outcome open.
for (const [name, reply, status] of [
  ['an explicit header status', () => packet({}, -402), -402],
  ['an explicit body status', () => packet({ status: -500 }), -500],
  ['a status beside a stored message', () => packet({ status: -5, ...stored }), -5],
  [
    'a chatLog that names another chat',
    () => written({ chatLog: { chatId: Long.fromString('43'), logId: stored.logId, sendAt: 1 } }),
    null,
  ],
  [
    'a chatLog that names another message',
    () => written({ chatLog: { chatId: stored.chatId, logId: Long.fromString('999'), sendAt: 1 } }),
    null,
  ],
  [
    'an outer chat that conflicts with a correct chatLog',
    () => written({ chatId: Long.fromString('43'), chatLog: stored }),
    null,
  ],
  ['no outer chat id beside a correct chatLog', () => packet({ chatLog: stored }), null],
  ['another command with a status and a stored message', () => ({ ...packet(stored, -5), method: 'OTHER' }), null],
  ['another command reporting success', () => ({ ...written(), method: 'WRITE' }), null],
  ['no sendAt', () => packet({ status: 0, chatId: stored.chatId, logId: stored.logId }), null],
  ['a zero sendAt', () => written({ sendAt: 0 }), null],
  ['a negative sendAt', () => written({ sendAt: -1 }), null],
  ['a fractional sendAt', () => written({ sendAt: 1.5 }), null],
  ['a text sendAt', () => written({ sendAt: '1700000002' }), null],
  ['a sendAt beyond the safe range', () => written({ sendAt: 2 ** 60 }), null],
  ['closed connection', closedPacket, null],
  [
    'lost reply',
    () => {
      throw new Error(`LOCO packet timeout for ${ROOM}`)
    },
    null,
  ],
  ['non-integer status', () => packet({}, Number.NaN), null],
  ['no chat id', () => packet({ status: 0, logId: Long.fromString(LOG), sendAt: 1 }), null],
  ['another chat', () => written({ chatId: Long.fromString('5') }), null],
  ['no log id', () => packet({ status: 0, chatId: Long.fromString(ROOM), sendAt: 1 }), null],
  ['chatLog of the wrong type', () => written({ chatLog: 'x' }), null],
] as const) {
  test(`redirect: WRITEMEDIA answered by ${name} is outcome-unknown, never success:false, and never resent`, async () => {
    const http = await FakeHttp.start()
    try {
      const second = new FakeSession({ SHIP: () => packet({}, -402) })
      let replace = () => {}
      const first = new FakeSession({
        SHIP: redirect,
        WRITEMEDIA: () => {
          replace()
          return reply()
        },
      })
      const f = fixture(first, { fetch: http.fetch })
      replace = () => f.replaceSession(second)
      await rejects(f.client.sendFile(ROOM, randomBytes(1000), 'report.dat'), 'send_file_failed', 'write', status)
      assert.equal(first.count('WRITEMEDIA'), 1)
      assert.equal(second.calls.length, 0)
      assert.deepEqual(http.paths(), ['/messaging/files/v1/prepare', '/offset-up/synthetic/ready/'])
    } finally {
      await http.close()
    }
  })
}

// ============================================================ multi-photo

test('multi-photo: every photo is uploaded, then one FORWARD registers the album', async () => {
  const media = await FakeMediaServer.start({ complete: { body: { status: 0 } } })
  try {
    const session = new FakeSession({
      MSHIP: () => tickets([media.port, media.port]),
      FORWARD: () => packet({ status: 0, logId: Long.fromString(LOG), sendAt: 5 }),
    })
    const f = fixture(session, { createConnection: media.createConnection })
    const result = await f.client.sendMultiPhoto(ROOM, photos())
    assert.deepEqual(result, { success: true, status_code: 0, chat_id: ROOM, log_id: LOG, sent_at: 5 })
    assert.deepEqual(
      media.uploads.map((upload) => upload.post!.method),
      ['MPOST', 'MPOST'],
    )
    assert.deepEqual(media.uploads.map((upload) => upload.received).sort(), [20_000, 30_000])
    assert.equal(session.count('FORWARD'), 1)
    const extra = session.calls[1]!.args[2] as Record<string, unknown>
    assert.deepEqual(extra.kl, ['synthetic-0', 'synthetic-1'])
    assert.deepEqual(extra.wl, [10, 30])
  } finally {
    await media.close()
  }
})

test('multi-photo: an MSHIP refusal returns the status; FORWARD answers short of success are unknown', async () => {
  const media = await FakeMediaServer.start({ complete: { body: { status: 0 } } })
  try {
    const io = { createConnection: media.createConnection }
    const refusedShip = fixture(new FakeSession({ MSHIP: () => packet({ status: -203 }) }), io)
    assert.deepEqual(await refusedShip.client.sendMultiPhoto(ROOM, photos()), rejected(-203))
    assert.equal(media.uploads.length, 0)

    for (const reply of [closedPacket(), packet({ status: 0, kl: ['k'], vhl: ['127.0.0.1'], pl: [media.port] })]) {
      const lostShip = fixture(new FakeSession({ MSHIP: () => reply }), io)
      await rejects(lostShip.client.sendMultiPhoto(ROOM, photos()), 'media_not_dispatched', 'ship')
    }

    const ports = () => tickets([media.port, media.port])
    const album = { status: 0, logId: Long.fromString(LOG), sendAt: 5 }
    for (const [reply, status] of [
      // No FORWARD status is known to prove that nothing was stored.
      [() => packet({}, -402), -402],
      [() => packet({ ...album, status: -5 }), -5],
      [() => ({ ...packet(album), method: 'WRITE' }), null],
      [() => packet({ ...album, chatId: Long.fromString('5') }), null],
      [
        () =>
          packet({
            ...album,
            chatId: Long.fromString(ROOM),
            chatLog: { chatId: Long.fromString('5'), logId: album.logId },
          }),
        null,
      ],
      [() => packet({ ...album, chatLog: { logId: Long.fromString('999') } }), null],
      [closedPacket, null],
      [() => packet({ status: 0 }), null],
      [
        () => {
          throw new Error('lost')
        },
        null,
      ],
    ] as const) {
      const lostForward = fixture(new FakeSession({ MSHIP: ports, FORWARD: reply }), io)
      await rejects(lostForward.client.sendMultiPhoto(ROOM, photos()), 'send_multi_photo_failed', 'write', status)
    }

    // The album's message without sendAt, beside a consistent chatLog: accepted as before.
    const logged = fixture(
      new FakeSession({
        MSHIP: ports,
        FORWARD: () =>
          packet({ status: 0, chatId: Long.fromString(ROOM), logId: album.logId, chatLog: { logId: album.logId } }),
      }),
      io,
    )
    assert.deepEqual(await logged.client.sendMultiPhoto(ROOM, photos()), {
      success: true,
      status_code: 0,
      chat_id: ROOM,
      log_id: LOG,
      sent_at: 0,
    })
  } finally {
    await media.close()
  }
})

test('multi-photo: a photo whose MPOST answer is lost created no message, unlike a single upload', async () => {
  // An MPOST cannot register anything: only the FORWARD does.
  const media = await FakeMediaServer.start({ post: 'close' })
  try {
    const session = new FakeSession({ MSHIP: () => tickets([media.port, media.port]) })
    const f = fixture(session, { createConnection: media.createConnection })
    await rejects(f.client.sendMultiPhoto(ROOM, photos()), 'media_not_dispatched', ['post', 'connect'])
    assert.equal(session.count('FORWARD'), 0)
  } finally {
    await media.close()
  }
})

test('multi-photo: one failed photo cancels the album before FORWARD and settles its sibling', async () => {
  // The sibling is held mid-stream until the failure cancels it.
  const media = await FakeMediaServer.start({ stopReadingAfter: 0, complete: null })
  try {
    const dead = await closedPort()
    const session = new FakeSession({ MSHIP: () => tickets([media.port, dead]) })
    const f = fixture(session, {
      createConnection: media.createConnection,
      trailerTiming: { connectMs: 3000, stallMs: 30_000, completeMs: 30_000 },
    })
    await rejects(f.client.sendMultiPhoto(ROOM, photos()), 'media_not_dispatched', 'connect')
    assert.equal(session.count('FORWARD'), 0)
    assert.equal(media.clientsClosed, true)

    const refused = await FakeMediaServer.start({ complete: { statusCode: -910, body: {} } })
    try {
      const g = fixture(new FakeSession({ MSHIP: () => tickets([refused.port, refused.port]) }), {
        createConnection: refused.createConnection,
      })
      assert.deepEqual(await g.client.sendMultiPhoto(ROOM, photos()), rejected(-910))
    } finally {
      await refused.close()
    }
  } finally {
    await media.close()
  }
})

// HTTP upload for a SHIP redirect (`rd: true`): prepare → chunked Kage upload →
// ready poll → the body of one WRITEMEDIA.
//
// Adapted (Go → TypeScript, modified) from https://github.com/frrad/mooo at
// a638e2447677510ba31766cfae35863b57487550: internal/protocol/media/direct.go,
// internal/protocol/media/directphoto.go and internal/client/media_direct.go,
// following research/bridge/SHIP-REDIRECT.md and SHIP-REDIRECT-FILE-VIDEO.md.
// NOTICE.md lists the deliberate differences. The original notice follows.
//
// MIT License
//
// Copyright (c) 2026 Frederick
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// A failure here always precedes WRITEMEDIA, so it never creates a message.
// Tickets, resources, upload keys and signed URLs are private: they are never
// put into an error.

import { randomBytes } from 'node:crypto'

import type { Long } from 'bson'

import { KAKAO_MESSAGE_TYPE } from '../types'
import { MediaStepError } from './media-outcome'

const PREPARE_URL = 'https://talk-pilsner.kakao.com/messaging/files/v1/prepare'
const READY_URL = 'https://talk-pilsner.kakao.com/messaging/files/v1/ready'
const KAGE_HOST = 'kage.talk.kakao.com'
const KAGE_PATH_PREFIX = '/offset-up/'
const KAGE_STRATEGY = 'vk'
const MAX_RESPONSE_BYTES = 1 << 20
const MAX_DIRECT_VALUE_BYTES = 16384
// The donor's bound on a prepared chunk size (its MaxUploadBytes).
const MAX_CHUNK_BYTES = 64 << 20
const CANONICAL_CHAT_ID = /^[1-9]\d{0,18}$/
const MAX_SIGNED_INT64 = 9223372036854775807n
const READY_DONE = 1
// A chunk body is handed to fetch in slices of this size so that its progress
// can be observed; see uploadStallMs.
const UPLOAD_SLICE_BYTES = 16384

export interface DirectTiming {
  /** One prepare or ready request. */
  requestMs: number
  /**
   * Longest a Kage chunk may go without fetch taking its next slice. It bounds
   * a stalled upload, not a slow one: at 16 KiB per slice it is passed only by
   * a link slower than about 1.6 kB/s for 10 s.
   */
  uploadStallMs: number
  /** Wait for a chunk's acknowledgement once fetch has taken its last slice. */
  chunkMs: number
  /** Poll interval when the server gives none; the Mac client's default. */
  readyIntervalMs: number
  /** Cap on the ready poll; the Mac client's default maxWaitSeconds. */
  readyMaxWaitMs: number
}

export const DIRECT_TIMING: DirectTiming = {
  requestMs: 20_000,
  uploadStallMs: 10_000,
  chunkMs: 120_000,
  readyIntervalMs: 5_000,
  readyMaxWaitMs: 600_000,
}

/** The one fetch shape this upload needs; the global fetch satisfies it. */
export type DirectFetch = (input: string, init: RequestInit) => Promise<Response>

export interface DirectHttp {
  fetch: DirectFetch
  /** Account headers with Authorization; sent to talk-pilsner only. */
  authorizedHeaders: Readonly<Record<string, string>>
  /** Client identity without credentials; all a signed upload URL receives. */
  uploadHeaders: Readonly<Record<string, string>>
  signal?: AbortSignal
  timing?: Partial<DirectTiming>
}

export interface DirectMedia {
  /** The prepare mediaType. */
  mediaType: 'image' | 'video' | 'file'
  /** Lowercase extension sent to prepare. */
  extension: string
  /** Content-Type of each uploaded chunk. */
  mimeType: string
  data: Uint8Array
}

/** Private, ephemeral upload authorization. Never log its fields. */
export interface DirectTicket {
  url: string
  resource: string
  resourceType: string
  uploadKey: string
  chunkSize: number
  needReady: boolean
  /** Multipart filename: the last path component of `resource`. */
  filename: string
}

// The donor's directVideoMIME. Files are sent as application/octet-stream,
// which the server accepted for any file.
const DIRECT_VIDEO_MIME: Readonly<Record<string, string>> = {
  ts: 'video/mp2t',
  ogv: 'video/ogg',
  flv: 'video/x-flv',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  mkv: 'video/x-matroska',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
}

function safeDirectValue(value: string): boolean {
  return value !== '' && Buffer.byteLength(value) <= MAX_DIRECT_VALUE_BYTES && !/[\0\r\n]/.test(value)
}

// Describes one payload for prepare and the Kage upload. Only photo, video and
// file have a traced HTTP form; a file without an extension cannot use it (the
// official client refuses it before prepare).
export function directMediaFor(
  msgType: number,
  extension: string,
  data: Uint8Array,
  imageMimeType?: string,
): DirectMedia {
  const ext = extension.normalize('NFC').toLowerCase()
  let media: DirectMedia
  switch (msgType) {
    case KAKAO_MESSAGE_TYPE.PHOTO:
      media = { mediaType: 'image', extension: ext, mimeType: imageMimeType ?? '', data }
      break
    case KAKAO_MESSAGE_TYPE.VIDEO:
      media = {
        mediaType: 'video',
        extension: ext,
        mimeType: DIRECT_VIDEO_MIME[ext] ?? 'application/octet-stream',
        data,
      }
      break
    case KAKAO_MESSAGE_TYPE.FILE:
      media = { mediaType: 'file', extension: ext, mimeType: 'application/octet-stream', data }
      break
    default:
      throw new MediaStepError('prepare', 'unsupported')
  }
  if (data.byteLength === 0 || !safeDirectValue(media.extension) || !safeDirectValue(media.mimeType)) {
    throw new MediaStepError('prepare', 'unsupported')
  }
  return media
}

// The donor's directJSONRequest headers on top of the account's own REST
// headers, and the credential-free set a signed upload URL gets. The upload
// set is an allow-list so Authorization can never reach the storage host.
export function directHeaders(
  account: Readonly<Record<string, string>>,
  identity: { agent: string; userId: string; language: string },
): Pick<DirectHttp, 'authorizedHeaders' | 'uploadHeaders'> {
  const uploadHeaders: Record<string, string> = {}
  for (const name of ['A', 'Accept-Language', 'User-Agent']) {
    const value = account[name]
    if (value !== undefined) uploadHeaders[name] = value
  }
  return {
    authorizedHeaders: {
      ...account,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
      'talk-agent': identity.agent,
      'talk-user-id': identity.userId,
      'talk-language': identity.language,
    },
    uploadHeaders,
  }
}

// Whether any object in valid JSON `text` repeats one of its own keys.
// JSON.parse keeps the last value of a repeated key, so two readers could act
// on different answers; the donor's strictjson refuses such input for the same
// reason. Every depth is checked, because nested objects are acted on too (a
// final upload acknowledgement's `info` entry).
function repeatsKey(text: string): boolean {
  // One entry per open container: an object's keys so far, or null for an array.
  const open: Array<{ keys: Set<string>; keyNext: boolean } | null> = []
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    const container = open.at(-1)
    if (char === '"') {
      let end = at + 1
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      if (container?.keyNext) {
        const key = JSON.parse(text.slice(at, end + 1)) as string
        if (container.keys.has(key)) return true
        container.keys.add(key)
        container.keyNext = false
      }
      at = end
    } else if (char === '{') {
      open.push({ keys: new Set(), keyNext: true })
    } else if (char === '[') {
      open.push(null)
    } else if (char === '}' || char === ']') {
      open.pop()
    } else if (char === ',' && container) {
      container.keyNext = true
    }
  }
  return false
}

/** Exactly one JSON object in which no object repeats a key, else null. */
function parseObject(text: string): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || repeatsKey(text)) return null
  return value as Record<string, unknown>
}

// A chat id can exceed 2^53, so its digits are written as a bare JSON number
// instead of passing through a JavaScript number.
function jsonWithChatId(chatId: string, rest: Record<string, unknown>): string {
  return `{"chatId":${chatId},${JSON.stringify(rest).slice(1)}`
}

function requireChatId(chatId: string, phase: 'prepare' | 'ready'): void {
  if (!CANONICAL_CHAT_ID.test(chatId) || BigInt(chatId) > MAX_SIGNED_INT64) {
    throw new MediaStepError(phase, 'unsupported')
  }
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('response too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

// One POST, never redirected and never retried. Returns whatever the server
// answered; a missing answer is a MediaStepError without detail.
//
// A string body is bounded by `timeoutMs` as a whole. A byte body is streamed
// to fetch in slices with its exact Content-Length, which puts the same bytes
// and headers on the wire as a buffered body: while slices are being taken
// only `uploadStallMs` without progress ends the request, and `timeoutMs`
// bounds the wait for the answer after the last slice.
async function directPost(
  http: DirectHttp,
  phase: 'prepare' | 'upload' | 'ready',
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string | Uint8Array,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  if (http.signal?.aborted) throw new MediaStepError(phase, 'aborted')
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  http.signal?.addEventListener('abort', onAbort, { once: true })
  let expired: 'timeout' | 'stalled' | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const expireAfter = (ms: number, failure: 'timeout' | 'stalled') => {
    clearTimeout(timer)
    // fetch can still take a slice while an ended request is torn down.
    if (settled) return
    timer = setTimeout(() => {
      expired = failure
      controller.abort()
    }, ms)
  }
  const init: RequestInit = { method: 'POST', headers: { ...headers }, redirect: 'manual', signal: controller.signal }
  if (typeof body === 'string') {
    init.body = body
    expireAfter(timeoutMs, 'timeout')
  } else {
    const stallMs = { ...DIRECT_TIMING, ...http.timing }.uploadStallMs
    let at = 0
    init.headers = { ...headers, 'Content-Length': String(body.byteLength) }
    init.duplex = 'half'
    init.body = new ReadableStream<Uint8Array>({
      pull(stream) {
        const end = Math.min(at + UPLOAD_SLICE_BYTES, body.byteLength)
        stream.enqueue(body.subarray(at, end))
        at = end
        if (at < body.byteLength) {
          expireAfter(stallMs, 'stalled')
        } else {
          stream.close()
          expireAfter(timeoutMs, 'timeout')
        }
      },
    })
    expireAfter(stallMs, 'stalled')
  }
  try {
    const response = await http.fetch(url, init)
    return { status: response.status, text: await boundedText(response) }
  } catch {
    throw new MediaStepError(phase, http.signal?.aborted ? 'aborted' : (expired ?? 'transport'))
  } finally {
    settled = true
    clearTimeout(timer)
    http.signal?.removeEventListener('abort', onAbort)
  }
}

// A non-2xx answer. It is the provider's explicit refusal when its JSON body
// carries a short digit `code` (the content filter answers "90025") or an
// integer `status`, or when the HTTP status is 4xx; that number is all that is
// kept of it. Anything else (a redirect, a 5xx from a gateway) is a failed
// request, not a refusal.
function refusal(phase: 'prepare' | 'upload' | 'ready', httpStatus: number, text: string): MediaStepError {
  const body = parseObject(text)
  const code = body?.code
  let status: unknown = httpStatus >= 400 && httpStatus < 500 ? httpStatus : 0
  if (typeof code === 'string' && /^-?\d{1,9}$/.test(code) && Number(code) !== 0) status = Number(code)
  else if (Number.isSafeInteger(code) && code !== 0) status = code
  else if (Number.isSafeInteger(body?.status) && body?.status !== 0) status = body?.status
  return Number.isSafeInteger(status) && status !== 0
    ? new MediaStepError(phase, 'rejected', { rejected: true, providerStatus: status as number })
    : new MediaStepError(phase, 'transport')
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

// Reads a field the way the donor's typed JSON decoding does: absent is the
// zero value, a wrong type fails the whole answer.
function field<T>(value: unknown, zero: T, accepts: (value: unknown) => value is T, phase: 'prepare' | 'ready'): T {
  if (value === undefined || value === null) return zero
  if (!accepts(value)) throw new MediaStepError(phase, 'malformed')
  return value
}
const isString = (value: unknown): value is string => typeof value === 'string'
const isInteger = (value: unknown): value is number => Number.isSafeInteger(value)
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

function resourceFilename(resource: string): string {
  // A relative path only: no scheme, authority, query or fragment.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(resource) || resource.startsWith('//') || /[?#]/.test(resource)) {
    throw new MediaStepError('prepare', 'malformed')
  }
  let path: string
  try {
    path = decodeURIComponent(resource)
  } catch {
    throw new MediaStepError('prepare', 'malformed')
  }
  const name = path.replace(/\/+$/, '').split('/').pop() ?? ''
  if (name === '' || name === '.' || !safeDirectValue(name) || /[\\"]/.test(name)) {
    throw new MediaStepError('prepare', 'malformed')
  }
  return name
}

function requireUploadUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new MediaStepError('prepare', 'malformed')
  }
  if (
    url.protocol !== 'https:' ||
    url.host !== KAGE_HOST ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !url.pathname.startsWith(KAGE_PATH_PREFIX)
  ) {
    throw new MediaStepError('prepare', 'malformed')
  }
}

// Reserves one HTTP upload after a SHIP redirect. Only the Kage ("vk")
// strategy is supported: a Tenth or unchunked ticket stops here, before any
// byte is uploaded.
export async function prepareDirect(http: DirectHttp, chatId: string, media: DirectMedia): Promise<DirectTicket> {
  requireChatId(chatId, 'prepare')
  const timing = { ...DIRECT_TIMING, ...http.timing }
  const { status, text } = await directPost(
    http,
    'prepare',
    PREPARE_URL,
    http.authorizedHeaders,
    jsonWithChatId(chatId, { mediaType: media.mediaType, size: media.data.byteLength, extension: media.extension }),
    timing.requestMs,
  )
  if (!isSuccess(status)) throw refusal('prepare', status, text)
  const raw = parseObject(text)
  if (!raw) throw new MediaStepError('prepare', 'malformed')
  const ticket = {
    url: field(raw.url, '', isString, 'prepare'),
    resource: field(raw.resource, '', isString, 'prepare'),
    resourceType: field(raw.resourceType, '', isString, 'prepare'),
    uploadKey: field(raw.uploadKey, '', isString, 'prepare'),
    chunkSize: field(raw.chunkSize, 0, isInteger, 'prepare'),
    needReady: field(raw.needReady, false, isBoolean, 'prepare'),
  }
  if (ticket.resourceType !== KAGE_STRATEGY || ticket.chunkSize <= 0) {
    throw new MediaStepError('prepare', 'unsupported')
  }
  if (ticket.chunkSize > MAX_CHUNK_BYTES || !safeDirectValue(ticket.uploadKey) || !safeDirectValue(ticket.resource)) {
    throw new MediaStepError('prepare', 'malformed')
  }
  requireUploadUrl(ticket.url)
  return { ...ticket, filename: resourceFilename(ticket.resource) }
}

// multipart/form-data with `offset` (the chunk's starting offset, as the Mac
// sends it) followed by `file_1`. The filename MUST be the prepared resource's
// last path component: the local name gets "Not found upload ready key".
function multipartChunk(
  offset: number,
  filename: string,
  mimeType: string,
  chunk: Uint8Array,
): { contentType: string; body: Uint8Array } {
  const boundary = `ser5-${randomBytes(24).toString('hex')}`
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="offset"\r\n\r\n${offset}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file_1"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([Buffer.from(head, 'utf8'), chunk, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]),
  }
}

// Checks one Kage acknowledgement (the donor's decodeDirectUpload). Every
// intermediate chunk must report the end of its range. The final one must say
// "ok"; a photo must also identify the resource, its full length and "image".
// For a file or video that info is checked only when present.
function requireUploadAck(
  text: string,
  mediaType: DirectMedia['mediaType'],
  filename: string,
  size: number,
  next: number,
  final: boolean,
): void {
  const ack = parseObject(text)
  if (!ack) throw new MediaStepError('upload', 'malformed')
  if (!final) {
    if (typeof ack.offset !== 'string' || !/^\d{1,15}$/.test(ack.offset) || Number(ack.offset) !== next) {
      throw new MediaStepError('upload', 'malformed')
    }
    return
  }
  if (ack.msg !== 'ok') throw new MediaStepError('upload', 'malformed')
  if (mediaType !== 'image' && (ack.info === undefined || ack.info === null)) return
  const info = Array.isArray(ack.info) && ack.info.length === 1 ? (ack.info[0] as unknown) : null
  const entry = info !== null && typeof info === 'object' ? (info as Record<string, unknown>) : null
  if (!entry || entry.filename !== filename || entry.length !== size) {
    throw new MediaStepError('upload', 'malformed')
  }
  if (mediaType === 'image' && entry.content_type !== 'image') throw new MediaStepError('upload', 'malformed')
}

// Sends each chunk once, in order. The signed URL gets no account
// Authorization, and Node's fetch keeps no cookie jar.
export async function uploadDirect(http: DirectHttp, ticket: DirectTicket, media: DirectMedia): Promise<void> {
  const timing = { ...DIRECT_TIMING, ...http.timing }
  const total = media.data.byteLength
  for (let start = 0; start < total; ) {
    const end = Math.min(start + ticket.chunkSize, total)
    const part = multipartChunk(start, ticket.filename, media.mimeType, media.data.subarray(start, end))
    const { status, text } = await directPost(
      http,
      'upload',
      ticket.url,
      { ...http.uploadHeaders, 'Content-Type': part.contentType },
      part.body,
      timing.chunkMs,
    )
    if (!isSuccess(status)) throw refusal('upload', status, text)
    requireUploadAck(text, media.mediaType, ticket.filename, total, end, end === total)
    start = end
  }
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MediaStepError('ready', 'aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new MediaStepError('ready', 'aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Polls until the server reports the uploaded media ready (status 1), sleeping
// the interval it returns, for at most its maxWaitSeconds capped at
// readyMaxWaitMs. prevStatus is 0 first and then the last status returned;
// jobId is the last job the server named, if any.
//
// The deadline is kept on the monotonic clock and only ever moves earlier: a
// later answer cannot extend it. No request or sleep outlasts it, and an
// answer that arrives after it is not acted on, whatever it says.
export async function waitDirectReady(
  http: DirectHttp,
  chatId: string,
  mediaType: DirectMedia['mediaType'],
  ticket: DirectTicket,
): Promise<void> {
  requireChatId(chatId, 'ready')
  const timing = { ...DIRECT_TIMING, ...http.timing }
  const started = performance.now()
  let deadline = started + timing.readyMaxWaitMs
  let prevStatus = 0
  let jobId = ''
  for (;;) {
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) throw new MediaStepError('ready', 'timeout')
    const request: Record<string, unknown> = {
      resource: ticket.resource,
      resourceType: ticket.resourceType,
      mediaType,
      uploadKey: ticket.uploadKey,
      prevStatus,
    }
    if (jobId !== '') request.jobId = jobId
    const { status, text } = await directPost(
      http,
      'ready',
      READY_URL,
      http.authorizedHeaders,
      jsonWithChatId(chatId, request),
      Math.min(timing.requestMs, remainingMs),
    )
    if (performance.now() >= deadline) throw new MediaStepError('ready', 'timeout')
    if (!isSuccess(status)) throw refusal('ready', status, text)
    const raw = parseObject(text)
    if (!raw) throw new MediaStepError('ready', 'malformed')
    const ready = {
      status: field(raw.status, 0, isInteger, 'ready'),
      intervalMs: field(raw.interval, 0, isInteger, 'ready'),
      maxWaitSeconds: field(raw.maxWaitSeconds, 0, isInteger, 'ready'),
      jobId: field(raw.jobId, '', isString, 'ready'),
    }
    if (ready.intervalMs < 0 || ready.maxWaitSeconds < 0 || (ready.jobId !== '' && !safeDirectValue(ready.jobId))) {
      throw new MediaStepError('ready', 'malformed')
    }
    if (ready.maxWaitSeconds > 0) {
      deadline = Math.min(deadline, started + ready.maxWaitSeconds * 1000)
    }
    // Checked again against the deadline as this answer leaves it, before the
    // answer is accepted as ready.
    if (performance.now() >= deadline) throw new MediaStepError('ready', 'timeout')
    if (ready.status === READY_DONE) return
    const intervalMs = ready.intervalMs > 0 ? ready.intervalMs : timing.readyIntervalMs
    if (performance.now() + intervalMs > deadline) throw new MediaStepError('ready', 'timeout')
    prevStatus = ready.status
    if (ready.jobId !== '') jobId = ready.jobId
    await abortableSleep(intervalMs, http.signal)
  }
}

export interface DirectWrite {
  chatId: Long
  msgId: Long
  /** KAKAO_MESSAGE_TYPE.PHOTO, VIDEO or FILE. */
  type: number
  ticket: DirectTicket
  /** Photo only. */
  width?: number
  height?: number
  /** File only: the message's file name and its SHA-1 as lowercase hex. */
  name?: string
  checksum?: string
}

// The WRITEMEDIA body of the Mac serializer: the message's own type and one
// nested media object carrying the resource triple (`hfac` is the upload key).
// A photo adds its dimensions, a file its name and lowercase SHA-1, a video
// nothing. No caption is sent: the SDK's media sends carry none.
export function buildDirectWriteBody(write: DirectWrite): Record<string, unknown> {
  const media: Record<string, unknown> = {
    resource: write.ticket.resource,
    resourceType: write.ticket.resourceType,
    hfac: write.ticket.uploadKey,
  }
  let mediaKey: 'photo' | 'video' | 'file'
  switch (write.type) {
    case KAKAO_MESSAGE_TYPE.PHOTO:
      if (!isInteger(write.width) || !isInteger(write.height) || write.width <= 0 || write.height <= 0) {
        throw new MediaStepError('prepare', 'unsupported')
      }
      mediaKey = 'photo'
      media.width = write.width
      media.height = write.height
      break
    case KAKAO_MESSAGE_TYPE.VIDEO:
      mediaKey = 'video'
      break
    case KAKAO_MESSAGE_TYPE.FILE:
      if (!write.name || !/^[0-9a-f]{40}$/.test(write.checksum ?? '')) {
        throw new MediaStepError('prepare', 'unsupported')
      }
      mediaKey = 'file'
      media.name = write.name
      media.checksum = write.checksum
      break
    default:
      throw new MediaStepError('prepare', 'unsupported')
  }
  return {
    chatId: write.chatId,
    msgId: write.msgId,
    scope: 1,
    type: write.type,
    noSeen: false,
    noLight: false,
    silence: false,
    [mediaKey]: media,
  }
}

// One attempt of a media send on one LOCO session. The client owns session
// acquisition, the reconnect rerun and the public result; this module owns the
// order of the provider steps and records how far the attempt got.
//
// The rule that decides what a failure means is `registrationAttempted`: it is
// set immediately before the first request that can create the chat message
// (a single upload's POST, WRITEMEDIA, or the album's FORWARD). A failure
// before it created no message. After it, only a success or a refusal that
// provably stored nothing is reported as such; everything else is ambiguous.

import { Long } from 'bson'

import type { ImageDimensions } from './image-meta'
import { LANG, getLocoDeviceConfig } from './protocol/config'
import {
  type DirectFetch,
  type DirectHttp,
  type DirectTiming,
  buildDirectWriteBody,
  directHeaders,
  directMediaFor,
  prepareDirect,
  uploadDirect,
  waitDirectReady,
} from './protocol/media-direct'
import { type MediaSendPhase, MediaStepError, openStatus, requireLocoOk } from './protocol/media-outcome'
import {
  type MediaLocoConnection,
  type MediaTrailerTiming,
  uploadMediaToLoco,
  uploadMultiMediaEntry,
} from './protocol/media-uploader'
import type { LocoPacket } from './protocol/types'
import { KAKAO_MESSAGE_TYPE, type KakaoDeviceType, type KakaoMultiPhotoExtra } from './types'

/** The main-session requests a media send makes; LocoSession provides them. */
export interface MediaSendSession {
  shipMedia(chatId: Long, type: number, size: number, checksum: string, extension: string): Promise<LocoPacket>
  shipMultiMedia(
    chatId: Long,
    type: number,
    sizes: number[],
    checksums: string[],
    extensions: string[],
  ): Promise<LocoPacket>
  forwardChat(chatId: Long, type: number, extra: Record<string, unknown>): Promise<LocoPacket>
  writeMedia(body: Record<string, unknown>): Promise<LocoPacket>
  /** null once the session is closed. */
  getConnection(): unknown
}

/** Where media bytes go. Defaults are the real media connection and fetch. */
export interface MediaIo {
  createConnection?: () => MediaLocoConnection
  fetch?: DirectFetch
  trailerTiming?: Partial<MediaTrailerTiming>
  directTiming?: Partial<DirectTiming>
}

export interface MediaSendAttempt {
  /** The step in progress, for a failure that names none itself. */
  phase: MediaSendPhase
  /** A request that can create the message may have reached the provider. */
  registrationAttempted: boolean
}

export interface MediaSendContext {
  session: MediaSendSession
  io: MediaIo
  userId: string
  deviceType: KakaoDeviceType
  /** The account's REST headers, from their existing owner. */
  accountHeaders: () => Record<string, string>
  /** A canonical positive signed 64-bit id as decimal digits, else null. */
  positiveId: (value: unknown) => string | null
  /** The caller's cancellation. */
  signal: AbortSignal
  /** Aborted when the client is closed. */
  closed: AbortSignal
  attempt: MediaSendAttempt
}

export type MediaSendOutcome =
  | { kind: 'sent'; logId: string; sentAt: number }
  /** The provider explicitly refused, and this attempt created no message. */
  | { kind: 'rejected'; phase: MediaSendPhase; providerStatus: number }

export interface SingleMedia {
  chatId: string
  parsedChatId: Long
  data: Uint8Array
  msgType: number
  filename: string
  /** SHA-1 as uppercase hex, as SHIP sends it. */
  checksum: string
  extension: string
  image?: ImageDimensions
}

export interface PreparedPhoto {
  bytes: Uint8Array
  filename: string
  dim: ImageDimensions
  checksum: string
  ext: string
}

function refusedOrThrow(error: unknown): MediaSendOutcome {
  if (error instanceof MediaStepError && error.rejected && error.providerStatus !== null) {
    return { kind: 'rejected', phase: error.phase, providerStatus: error.providerStatus }
  }
  throw error
}

function throwIfAborted(context: MediaSendContext): void {
  if (context.signal.aborted) throw new MediaStepError(context.attempt.phase, 'aborted')
}

// Opens the registration request of this attempt (WRITEMEDIA or FORWARD). A
// cancelled send or an already closed session cannot have sent it, so those
// still created no message; from here on a missing answer is ambiguous.
function beginRegistration(context: MediaSendContext): void {
  context.attempt.phase = 'write'
  throwIfAborted(context)
  if (context.session.getConnection() === null) throw new MediaStepError('write', 'closed')
  context.attempt.registrationAttempted = true
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

// The stored message a registration answer names.
//
// Where the position is read from follows each command's own reader: COMPLETE
// in its chatLog and FORWARD in the answer itself, as this SDK has always read
// them (a positive log id, sendAt defaulting to 0); WRITEMEDIA as the donor
// reads it (DecodeDirectWrite, SendResultPosition), in chatLog when one is
// returned, naming this chat and carrying a positive sendAt.
//
// Whatever the command, the answer must not contradict itself or the request:
// every chat id it states, in the answer or in its chatLog, must be this chat,
// and every log id it states must be the same one.
function storedMessage(
  context: MediaSendContext,
  phase: MediaSendPhase,
  body: Record<string, unknown>,
  chatId: string,
  command: 'COMPLETE' | 'FORWARD' | 'WRITEMEDIA',
): MediaSendOutcome {
  const chatLog = body.chatLog === undefined ? undefined : record(body.chatLog)
  const stated = chatLog ? [body, chatLog] : [body]
  const position = command === 'FORWARD' ? body : command === 'COMPLETE' ? chatLog : (chatLog ?? body)
  const logId = context.positiveId(position?.logId)
  const sendAt = position?.sendAt
  const exact = command === 'WRITEMEDIA'
  if (
    chatLog === null ||
    logId === null ||
    stated.some((part) => part.chatId !== undefined && context.positiveId(part.chatId) !== chatId) ||
    stated.some((part) => part.logId !== undefined && context.positiveId(part.logId) !== logId) ||
    (exact && body.chatId === undefined) ||
    (exact && !(typeof sendAt === 'number' && Number.isSafeInteger(sendAt) && sendAt > 0))
  ) {
    throw new MediaStepError(phase, 'malformed')
  }
  return { kind: 'sent', logId, sentAt: typeof sendAt === 'number' ? sendAt : 0 }
}

// Reads the answer to this attempt's registration request. The donor names no
// WRITEMEDIA status that proves nothing was stored (its research calls a
// failed reply ambiguous), and FORWARD has no such evidence either, so even an
// explicit non-zero status leaves the outcome open.
function registered(
  context: MediaSendContext,
  reply: LocoPacket,
  command: 'WRITEMEDIA' | 'FORWARD',
  chatId: string,
): MediaSendOutcome {
  try {
    requireLocoOk(reply, 'write', command)
  } catch (error) {
    throw error instanceof MediaStepError && error.rejected ? openStatus('write', error) : error
  }
  return storedMessage(context, 'write', reply.body, chatId, command)
}

/** SHIP, then the upload path the provider selects, then the registration. */
export async function sendSingleMedia(context: MediaSendContext, item: SingleMedia): Promise<MediaSendOutcome> {
  const { attempt } = context
  attempt.phase = 'ship'
  throwIfAborted(context)
  const ship = await context.session.shipMedia(
    item.parsedChatId,
    item.msgType,
    item.data.byteLength,
    item.checksum,
    item.extension,
  )
  // SHIP only issues an upload ticket, so a refused or lost SHIP sent nothing.
  try {
    requireLocoOk(ship, 'ship')
  } catch (error) {
    return refusedOrThrow(error)
  }
  // The redirect is read before the trailer fields (donor DecodeShipResponse):
  // an omitted rd is false, a wrong type fails, and a redirect supplies no
  // usable trailer endpoint even when k/vh/p are present.
  const redirect = ship.body.rd
  if (redirect !== undefined && typeof redirect !== 'boolean') throw new MediaStepError('ship', 'malformed')
  if (redirect === true) return sendRedirected(context, item)

  const { k: shipToken, vh: shipHost, p: shipPort } = ship.body
  if (!nonEmptyString(shipToken) || !nonEmptyString(shipHost) || !validPort(shipPort)) {
    throw new MediaStepError('ship', 'malformed')
  }
  let completePacket: LocoPacket
  try {
    const upload = await uploadMediaToLoco({
      shipToken,
      shipHost,
      shipPort,
      chatId: item.parsedChatId,
      msgType: item.msgType,
      userId: context.userId,
      filename: item.filename,
      data: item.data,
      width: item.image?.width,
      height: item.image?.height,
      deviceType: context.deviceType,
      signal: context.signal,
      createConnection: context.io.createConnection,
      timing: context.io.trailerTiming,
      // The server registers the message when it sends COMPLETE, which can
      // follow the POST alone when it already holds every byte. The outcome
      // is open from the POST on.
      onPostDispatch: () => {
        attempt.registrationAttempted = true
      },
    })
    completePacket = upload.completePacket
  } catch (error) {
    return refusedOrThrow(error)
  }
  attempt.phase = 'complete'
  return storedMessage(context, 'complete', completePacket.body, item.chatId, 'COMPLETE')
}

// The HTTP upload a SHIP redirect selects, on the same LOCO session: prepare,
// chunked Kage upload, the ready poll when prepare asks for one, then exactly
// one WRITEMEDIA. No step is repeated within an attempt. The client may run
// a whole new attempt after a lost session, but only while no WRITEMEDIA has
// been sent.
async function sendRedirected(context: MediaSendContext, item: SingleMedia): Promise<MediaSendOutcome> {
  const { attempt } = context
  attempt.phase = 'prepare'
  const media = directMediaFor(item.msgType, item.extension, item.data, item.image?.mimeType)
  const device = getLocoDeviceConfig(context.deviceType)
  const http: DirectHttp = {
    fetch: context.io.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    ...directHeaders(context.accountHeaders(), {
      // The Mac client sends "macos/<version>"; the other identities send
      // their LOCO os token, which is not confirmed against the provider.
      agent: `${device.os === 'mac' ? 'macos' : device.os}/${device.appVersion}`,
      userId: context.userId,
      language: LANG,
    }),
    // This path registers on the main session, so a closed client ends it;
    // the trailer path finishes on its own media connection instead.
    signal: AbortSignal.any([context.signal, context.closed]),
    timing: context.io.directTiming,
  }
  let writeBody: Record<string, unknown>
  try {
    const ticket = await prepareDirect(http, item.chatId, media)
    // Built before the upload so a local refusal precedes any stored byte.
    writeBody = buildDirectWriteBody({
      chatId: item.parsedChatId,
      msgId: Long.fromNumber(Date.now()),
      type: item.msgType,
      ticket,
      width: item.image?.width,
      height: item.image?.height,
      name: item.filename.normalize('NFC'),
      checksum: item.checksum.toLowerCase(),
    })
    attempt.phase = 'upload'
    await uploadDirect(http, ticket, media)
    if (ticket.needReady) {
      attempt.phase = 'ready'
      await waitDirectReady(http, item.chatId, media.mediaType, ticket)
    }
  } catch (error) {
    return refusedOrThrow(error)
  }

  // The server creates the message only on WRITEMEDIA.
  beginRegistration(context)
  return registered(context, await context.session.writeMedia(writeBody), 'WRITEMEDIA', item.chatId)
}

// MSHIP, one MPOST upload per photo, then one FORWARD that registers the
// album. Every upload precedes the FORWARD, so a failed photo leaves no
// message even when its bytes were stored.
export async function sendMultiPhotoMedia(
  context: MediaSendContext,
  album: { chatId: string; parsedChatId: Long; photos: readonly PreparedPhoto[] },
): Promise<MediaSendOutcome> {
  const { parsedChatId: chatId, photos } = album
  const { attempt } = context
  attempt.phase = 'ship'
  throwIfAborted(context)
  const mship = await context.session.shipMultiMedia(
    chatId,
    KAKAO_MESSAGE_TYPE.MULTIPHOTO,
    photos.map((p) => p.bytes.byteLength),
    photos.map((p) => p.checksum),
    photos.map((p) => p.ext),
  )
  try {
    requireLocoOk(mship, 'ship')
  } catch (error) {
    return refusedOrThrow(error)
  }
  const { kl, vhl, pl } = mship.body
  if (
    !Array.isArray(kl) ||
    !Array.isArray(vhl) ||
    !Array.isArray(pl) ||
    kl.length !== photos.length ||
    vhl.length !== photos.length ||
    pl.length !== photos.length ||
    !kl.every(nonEmptyString) ||
    !vhl.every(nonEmptyString) ||
    !pl.every(validPort)
  ) {
    throw new MediaStepError('ship', 'malformed')
  }

  // The first failed photo cancels its siblings, and every upload has settled
  // (its connection closed, its bytes no longer read) before this returns.
  attempt.phase = 'connect'
  const siblings = new AbortController()
  const cancelSiblings = () => siblings.abort()
  context.signal.addEventListener('abort', cancelSiblings, { once: true })
  if (context.signal.aborted) siblings.abort()
  const failures: unknown[] = []
  try {
    await Promise.all(
      photos.map((p, i) =>
        uploadMultiMediaEntry({
          shipToken: kl[i]!,
          shipHost: vhl[i]!,
          shipPort: pl[i]!,
          chatId,
          msgType: KAKAO_MESSAGE_TYPE.MULTIPHOTO,
          userId: context.userId,
          filename: p.filename,
          data: p.bytes,
          width: p.dim.width,
          height: p.dim.height,
          deviceType: context.deviceType,
          signal: siblings.signal,
          createConnection: context.io.createConnection,
          timing: context.io.trailerTiming,
        }).catch((error: unknown) => {
          failures.push(error)
          siblings.abort()
        }),
      ),
    )
  } finally {
    context.signal.removeEventListener('abort', cancelSiblings)
  }
  // The first failure is the cause; the rest are its cancelled siblings.
  if (failures.length > 0) return refusedOrThrow(failures[0])

  const extra: KakaoMultiPhotoExtra = {
    kl,
    wl: photos.map((p) => p.dim.width),
    hl: photos.map((p) => p.dim.height),
    mtl: photos.map((p) => p.dim.mimeType),
    sl: photos.map((p) => p.bytes.byteLength),
    csl: photos.map((p) => p.checksum),
    cmtl: photos.map(() => ''),
  }

  beginRegistration(context)
  const forward = await context.session.forwardChat(
    chatId,
    KAKAO_MESSAGE_TYPE.MULTIPHOTO,
    extra as unknown as Record<string, unknown>,
  )
  return registered(context, forward, 'FORWARD', album.chatId)
}

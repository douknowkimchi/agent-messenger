import { Long } from 'bson'

import type { KakaoDeviceType } from '../types'
import { MCCMNC, getLocoDeviceConfig } from './config'
import { LocoConnection } from './connection'
import { MediaStepError, type MediaStepFailure, namesStoredMessage, openStatus, requireLocoOk } from './media-outcome'
import type { LocoPacket } from './types'

/** The part of LocoConnection one dedicated media connection uses. */
export type MediaLocoConnection = Pick<
  LocoConnection,
  'connectSecure' | 'sendPacket' | 'writeRaw' | 'onPush' | 'onClose' | 'close'
>

export interface MediaTrailerTiming {
  connectMs: number
  /** Longest one slice of the stream may take to leave; progress, not total time. */
  stallMs: number
  /** Wait for COMPLETE, counted from the last streamed byte. */
  completeMs: number
}

// Timeouts adapted from frrad/mooo@a638e244 internal/client/media.go and its
// research/media-upload-stream.md section 3 (MIT; see NOTICE.md): the Mac
// client connects within 15 s and restarts a 10 s watchdog on every write, so
// a slow upload continues and only a stalled one fails. The Mac waits for
// COMPLETE with no timer; the donor bounds that wait at 60 s after the last
// byte because a bridge needs an answer, and a timeout there stays ambiguous.
export const MEDIA_TRAILER_TIMING: MediaTrailerTiming = { connectMs: 15_000, stallMs: 10_000, completeMs: 60_000 }

// The file still travels as ONE secure frame, the framing this SDK has always
// sent and the only one observed against the media server from it. The donor
// reports that the official clients send 4096-byte (Mac) and 8192-byte
// (Android) frames, but no multi-frame upload from a third-party client has
// been observed, so the framing is not changed here.
//
// Progress is observed below the framing instead: the frame is handed to the
// socket in slices of this size, one at a time, and the stall limit applies
// to each slice. A slice is one official Android frame's worth of bytes, so
// the limit is passed only by a link slower than about 0.8 kB/s for 10 s.
const STREAM_SLICE_BYTES = 8192

export interface UploadToLocoOptions {
  shipToken: string
  shipHost: string
  shipPort: number
  chatId: Long
  msgType: number
  userId: string
  filename: string
  data: Uint8Array
  width?: number
  height?: number
  deviceType: KakaoDeviceType
  onProgress?: (sent: number, total: number) => void
  /** Closes the media connection; what that means for the message is the caller's call. */
  signal?: AbortSignal
  /** Called once, immediately before POST or MPOST is written to the media server. */
  onPostDispatch?: () => void
  createConnection?: () => MediaLocoConnection
  timing?: Partial<MediaTrailerTiming>
}

export interface UploadToLocoResult {
  /** The server's COMPLETE: named COMPLETE, with an explicit success status. */
  completePacket: LocoPacket
  postOffset: number
}

const DEFAULT_NETWORK_TYPE = 0

// Drives the SHIP → connect → POST → stream → COMPLETE pipeline that KakaoTalk
// uses for chat-media uploads. The caller has already done SHIP on the main
// session and received {k, vh, p}; this opens a dedicated TCP+LOCO connection
// to (vh, p), sends POST with the ticket + chat metadata, streams the raw file
// bytes, and waits for the server's COMPLETE push that triggers the actual
// chat-message registration.
//
// Field names (u/k/t/s/c/mid/w/h/mm/nt/os/av/f/ns) match the APK's
// `SR/g0.java` (PostJob) verbatim. The COMPLETE handshake is a server-pushed
// packet whose body contains the resulting chatLog struct.
//
// Every failure is a MediaStepError naming the step (connect, post, stream or
// complete). It is `rejected` only for an explicit refusal that no COMPLETE
// or stored message contradicts.
export async function uploadMediaToLoco(opts: UploadToLocoOptions): Promise<UploadToLocoResult> {
  return runPostStreamComplete(opts, 'POST')
}

// Single-entry MPOST upload — runs the same connect → POST → stream → COMPLETE
// pipeline as uploadMediaToLoco but with MPOST as the opcode (used after MSHIP
// for each entry in a multi-photo batch). Callers fan-out across all entries
// in parallel and then issue one FORWARD to register the gallery message.
export async function uploadMultiMediaEntry(opts: UploadToLocoOptions): Promise<UploadToLocoResult> {
  return runPostStreamComplete(opts, 'MPOST')
}

// The server's resume offset. As before (and as Android reads it), anything
// that is not a number means the start. A number outside 0..size streams
// nothing, as in the donor's DecodePostOffset and on Android.
function resumeOffset(value: unknown, size: number): number {
  if (typeof value !== 'number') return 0
  if (!Number.isInteger(value) || value < 0 || value > size) {
    throw new MediaStepError('post', 'malformed')
  }
  return value
}

async function runPostStreamComplete(opts: UploadToLocoOptions, opcode: 'POST' | 'MPOST'): Promise<UploadToLocoResult> {
  const device = getLocoDeviceConfig(opts.deviceType)
  const timing = { ...MEDIA_TRAILER_TIMING, ...opts.timing }
  const totalSize = opts.data.byteLength
  let phase: 'connect' | 'post' | 'stream' | 'complete' = 'connect'
  if (opts.signal?.aborted) throw new MediaStepError(phase, 'aborted')

  const conn = (opts.createConnection ?? (() => new LocoConnection()))()
  let stopped: 'aborted' | 'closed' | null = null
  let onStop: ((failure: 'aborted' | 'closed') => void) | null = null
  const stop = (failure: 'aborted' | 'closed') => {
    stopped ??= failure
    onStop?.(stopped)
  }
  // Cancellation closes the dedicated connection, which interrupts a blocked
  // write or a wait for COMPLETE.
  const onAbort = () => {
    stop('aborted')
    conn.close()
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  // Awaits one step until it settles, the connection stops, or `timeoutMs`
  // passes without it settling.
  const step = <T>(work: Promise<T>, timeoutMs: number | null, timeout: MediaStepFailure): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (finish: () => void) => {
        if (timer) clearTimeout(timer)
        if (onStop === stopListener) onStop = null
        finish()
      }
      const stopListener = (failure: 'aborted' | 'closed') => settle(() => reject(new MediaStepError(phase, failure)))
      work.then(
        (value) => settle(() => resolve(value)),
        (error: unknown) =>
          settle(() => reject(error instanceof MediaStepError ? error : new MediaStepError(phase, 'transport'))),
      )
      if (stopped) {
        stopListener(stopped)
        return
      }
      onStop = stopListener
      if (timeoutMs !== null) {
        timer = setTimeout(() => settle(() => reject(new MediaStepError(phase, timeout))), timeoutMs)
      }
    })

  // COMPLETE is a push on this connection. It can also arrive while the POST
  // answer is still awaited, or under the POST's own packet id.
  const completion: { packet: LocoPacket | null } = { packet: null }
  let announce = () => {}
  const completed = new Promise<void>((resolve) => {
    announce = resolve
  })
  const complete = (packet: LocoPacket) => {
    completion.packet ??= packet
    announce()
  }
  conn.onPush((push) => {
    if (push.method === 'COMPLETE') complete(push)
  })
  conn.onClose(() => stop('closed'))

  try {
    await step(conn.connectSecure(opts.shipHost, opts.shipPort), timing.connectMs, 'timeout')
    if (stopped) throw new MediaStepError(phase, stopped)

    const postBody: Record<string, unknown> = {
      k: opts.shipToken,
      s: totalSize,
      t: opts.msgType,
      u: Long.fromString(opts.userId),
      os: device.os,
      av: device.appVersion,
      nt: DEFAULT_NETWORK_TYPE,
      mm: MCCMNC,
    }
    if (opcode === 'POST') {
      postBody.f = opts.filename
      postBody.c = opts.chatId
      postBody.mid = Long.ONE
      postBody.ns = true
      if (typeof opts.width === 'number') postBody.w = opts.width
      if (typeof opts.height === 'number') postBody.h = opts.height
    } else {
      postBody.dt = 0
      postBody.scp = 0
    }

    // sendPacket bounds its own reply. A COMPLETE that arrives first settles
    // the upload whatever becomes of the POST answer.
    phase = 'post'
    opts.onPostDispatch?.()
    const posted = conn.sendPacket(opcode, postBody)
    const reply = await step(Promise.race([posted, completed.then(() => null)]), null, 'timeout')
    let postOffset = 0
    if (reply?.method === 'COMPLETE') {
      complete(reply)
    } else if (reply) {
      try {
        // Matched by packet id alone, as before; see requireLocoOk.
        requireLocoOk(reply, 'post')
      } catch (error) {
        // An explicit non-zero POST status that nothing contradicts stays a certain
        // refusal (donor research/media-upload-stream.md section 5: nothing is streamed
        // after it). Beside a COMPLETE or a stored message it contradicts itself.
        const contradicted = completion.packet !== null || namesStoredMessage(reply.body)
        throw error instanceof MediaStepError && error.rejected && contradicted ? openStatus('post', error) : error
      }
      postOffset = resumeOffset(reply.body.o, totalSize)

      // An offset at the end streams nothing; the server may still complete.
      phase = 'stream'
      if (postOffset < totalSize && !completion.packet) {
        const body = Buffer.from(opts.data.buffer, opts.data.byteOffset + postOffset, totalSize - postOffset)
        const streaming = conn.writeRaw(body, {
          bytes: STREAM_SLICE_BYTES,
          // One slice in flight; the stall timer restarts with each slice.
          each: (write) => step(write, timing.stallMs, 'stalled'),
        })
        streaming.catch(() => {})
        await Promise.race([streaming, completed])
      }
      opts.onProgress?.(totalSize, totalSize)
    }

    phase = 'complete'
    if (!completion.packet) await step(completed, timing.completeMs, 'timeout')
    const completePacket = completion.packet!
    try {
      requireLocoOk(completePacket, 'complete', 'COMPLETE')
    } catch (error) {
      // An explicit non-zero COMPLETE status is the server's refusal to create the
      // message (same section: "Certain, refused"), unless it also names a stored one.
      throw error instanceof MediaStepError && error.rejected && namesStoredMessage(completePacket.body)
        ? openStatus('complete', error)
        : error
    }
    return { completePacket, postOffset }
  } catch (error) {
    throw error instanceof MediaStepError ? error : new MediaStepError(phase, 'transport')
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    conn.close()
  }
}

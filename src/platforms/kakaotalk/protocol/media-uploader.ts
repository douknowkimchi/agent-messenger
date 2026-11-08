import { Long } from 'bson'

import type { KakaoDeviceType } from '../types'
import { MCCMNC, getLocoDeviceConfig } from './config'
import { LocoConnection } from './connection'
import type { LocoPacket } from './types'

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
}

export interface UploadToLocoResult {
  completePacket: LocoPacket | null
  postStatusCode: number
  postOffset: number
}

const DEFAULT_NETWORK_TYPE = 0
const DEFAULT_COMPLETE_TIMEOUT_MS = 60_000

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

async function runPostStreamComplete(opts: UploadToLocoOptions, opcode: 'POST' | 'MPOST'): Promise<UploadToLocoResult> {
  const device = getLocoDeviceConfig(opts.deviceType)
  const conn = new LocoConnection()
  const totalSize = opts.data.byteLength
  let completeResolve: ((p: LocoPacket | null) => void) | null = null
  let completeTimeout: ReturnType<typeof setTimeout> | null = null
  let connectionClosed = false
  const finishComplete = (packet: LocoPacket | null) => {
    if (completeTimeout) clearTimeout(completeTimeout)
    completeTimeout = null
    const resolve = completeResolve
    completeResolve = null
    resolve?.(packet)
  }
  conn.onClose(() => { connectionClosed = true; finishComplete(null) })

  try {
    // The allocated connection is owned even if connect/handshake fails.
    await conn.connectSecure(opts.shipHost, opts.shipPort)
    if (connectionClosed) throw new Error('Media upload connection closed')
    const completePromise = new Promise<LocoPacket | null>((resolve) => {
      completeResolve = resolve
      completeTimeout = setTimeout(() => finishComplete(null), DEFAULT_COMPLETE_TIMEOUT_MS)
    })
    conn.onPush((push) => { if (push.method === 'COMPLETE') finishComplete(push) })

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

    const postResp = await conn.sendPacket(opcode, postBody)
    if (connectionClosed) throw new Error('Media upload connection closed')
    if (postResp.statusCode !== 0 || !postResp.body || typeof postResp.body !== 'object' ||
        Array.isArray(postResp.body) || (postResp.body.status !== undefined && postResp.body.status !== 0)) {
      // Do not stream payload on a refused or malformed admission. The caller
      // keeps thrown upload outcomes conservative rather than inventing success.
      throw new Error(`${opcode} upload admission unavailable`)
    }
    const postOffsetRaw = postResp.body.o
    const postOffset = postOffsetRaw === undefined ? 0 : postOffsetRaw
    if (typeof postOffset !== 'number' || !Number.isSafeInteger(postOffset) || postOffset < 0 || postOffset > totalSize) {
      throw new Error(`${opcode} upload offset invalid`)
    }

    const bytesToSend = opts.data.subarray(postOffset)
    if (bytesToSend.length > 0) {
      await conn.writeRaw(Buffer.from(bytesToSend))
      opts.onProgress?.(totalSize, totalSize)
    }
    const completePacket = await completePromise
    return { completePacket, postStatusCode: postResp.statusCode, postOffset }
  } finally {
    finishComplete(null)
    conn.close()
  }
}

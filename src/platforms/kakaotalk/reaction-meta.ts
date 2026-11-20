// The general (legacy, type-1) reaction aggregate of one CHGLOGMETA push.
//
// Adapted (Go → TypeScript, modified) from https://github.com/frrad/mooo at
// a638e2447677510ba31766cfae35863b57487550: internal/protocol/events/events.go
// (decodeLogMeta and the type-1 branch of logMetaEvent), following
// research/replies-and-reactions.md and research/bridge/REACTION-COMPATIBILITY.md.
// protocol/NOTICE.md lists the deliberate differences. The original notice follows.
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

import { Long } from 'bson'

import { positiveSignedInt64String } from './client'
import type { KakaoReactionCount, KakaoReactionKind, KakaoTalkPushReactionEvent } from './types'

const KIND_KEYS = new Set(['1', '2', '3', '4', '5', '6'])

// A BSON integer as the packet decoder delivers it: a number up to 2^53
// (exact, though 2^53 itself is not a safe integer), or a Long beyond that.
// Strings and other shapes are not wire integers.
function wireId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value <= 2 ** 53 ? BigInt(value).toString() : null
  }
  return Long.isLong(value) ? positiveSignedInt64String(value) : null
}

/**
 * The type-1 aggregate of a CHGLOGMETA body, or null when the body is another
 * metadata type (type 2 carries mini/custom `rx` items) or is malformed. A
 * null result names nothing: the caller still has the generic push, and
 * absence must never be read as zero reactions.
 */
export function decodeReactionPush(body: Record<string, unknown>): KakaoTalkPushReactionEvent | null {
  const chatId = wireId(body.chatId)
  const logId = wireId(body.logId)
  const metaType = wireId(body.type)
  const revision = wireId(body.revision)
  if (chatId === null || logId === null || metaType !== '1' || revision === null) return null
  // Direct chats carry no link or a null one; an open chat's is positive.
  let linkId: string | null = null
  if (body.linkId != null && body.linkId !== 0) {
    linkId = wireId(body.linkId)
    if (linkId === null) return null
  }
  if (typeof body.content !== 'string') return null
  let counts: unknown
  try {
    counts = JSON.parse(body.content)
  } catch {
    return null
  }
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return null
  const reactions: KakaoReactionCount[] = []
  for (const [key, count] of Object.entries(counts)) {
    if (!KIND_KEYS.has(key) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null
    reactions.push({ kind: Number(key) as KakaoReactionKind, count })
  }
  reactions.sort((a, b) => a.kind - b.kind)
  return { type: 'CHGLOGMETA', chat_id: chatId, log_id: logId, link_id: linkId, revision, reactions }
}

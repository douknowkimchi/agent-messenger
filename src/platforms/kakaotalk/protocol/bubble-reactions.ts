// The general (legacy) bubble-reaction HTTP API: one reaction change and the
// current reaction members of one message.
//
// Adapted (Go → TypeScript, modified) from https://github.com/frrad/mooo at
// a638e2447677510ba31766cfae35863b57487550: internal/protocol/reactions/reactions.go
// and internal/protocol/macweb/macweb.go, following research/replies-and-reactions.md
// and research/bridge/reaction-failure-policy.md. NOTICE.md lists the deliberate
// differences. The original notice follows.
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
// Credentials, URLs and response bodies never enter a result or an error.

import { boundedText, parseObject } from './media-direct'

const BASE = 'https://talk-pilsner.kakao.com/messaging/chats/'
const CANONICAL_ID = /^[1-9]\d{0,18}$/
const MAX_SIGNED_INT64 = 9223372036854775807n
const KIND_KEYS = ['1', '2', '3', '4', '5', '6'] as const
export const BUBBLE_REACTION_TIMEOUT_MS = 15_000

/** 0 cancels this account's reaction; 1..6 heart, like, check, laugh, surprise, sad. */
export type BubbleReactionKind = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * One change, sent at most once and never retried here.
 * - not_sent: refused before any request left this process.
 * - accepted: 2xx with status 0 and no `result: false`.
 * - rejected: the server answered a refusal (2xx with a non-zero status or
 *   `result: false`, or 4xx). Whether the change was applied is still not
 *   established; only the answer was a refusal.
 * - unknown: anything else (transport, timeout, redirect, 5xx, malformed body).
 */
export type BubbleReactionOutcome =
  | { outcome: 'not_sent' }
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; providerStatus: number | null }
  | { outcome: 'unknown' }

/** The current members of each general kind. Ids are exact decimal strings. */
export interface BubbleReactionMembers {
  /** Positive revision, or null when the answer carries none (or 0). */
  revision: string | null
  members: Record<(typeof KIND_KEYS)[number], string[]>
}

export class BubbleReactionReadError extends Error {
  constructor(readonly reason: 'invalid_request' | 'transport' | 'rejected' | 'malformed') {
    super(`Bubble reaction members unavailable (${reason})`)
    this.name = 'BubbleReactionReadError'
  }
}

export interface BubbleReactionHttp {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  /** Account headers with Authorization; sent to talk-pilsner only. */
  authorizedHeaders: Readonly<Record<string, string>>
  timeoutMs?: number
}

function canonicalId(value: string): boolean {
  return CANONICAL_ID.test(value) && BigInt(value) <= MAX_SIGNED_INT64
}

function isKind(value: unknown): value is BubbleReactionKind {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6
}

export async function oneRequest(
  http: BubbleReactionHttp,
  url: string,
  init: RequestInit,
): Promise<{ status: number; text: string } | null> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // The deadline covers the whole exchange, also for a fetch that ignores
  // its signal: the request is then abandoned, never repeated.
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, http.timeoutMs ?? BUBBLE_REACTION_TIMEOUT_MS)
  })
  const exchange = (async () => {
    const response = await http.fetch(url, { ...init, redirect: 'manual', signal: controller.signal })
    return { status: response.status, text: await boundedText(response) }
  })().catch(() => null)
  try {
    return await Promise.race([exchange, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Sends one reaction change. `chatId` and `logId` are canonical decimal ids;
 * the log id is written into the JSON as its exact digits, so an id above 2^53
 * names the same message. Open chats are not supported (no link id is sent).
 */
export async function setBubbleReactionOnce(
  http: BubbleReactionHttp,
  chatId: string,
  logId: string,
  kind: BubbleReactionKind,
  requestId: number,
): Promise<BubbleReactionOutcome> {
  if (
    !canonicalId(chatId) ||
    !canonicalId(logId) ||
    !isKind(kind) ||
    !Number.isSafeInteger(requestId) ||
    requestId <= 0
  ) {
    return { outcome: 'not_sent' }
  }
  const body = `{"logId":${logId},"type":${kind},"reqId":${requestId}}`
  const answer = await oneRequest(http, `${BASE}${chatId}/bubble/reactions`, {
    method: 'POST',
    headers: { ...http.authorizedHeaders, 'Content-Type': 'application/json' },
    body,
  })
  if (answer === null) return { outcome: 'unknown' }
  if (answer.status >= 400 && answer.status < 500) return { outcome: 'rejected', providerStatus: null }
  if (answer.status < 200 || answer.status >= 300) return { outcome: 'unknown' }
  const value = parseObject(answer.text)
  if (value === null) return { outcome: 'unknown' }
  const { status, result } = value
  if (status !== undefined && !Number.isSafeInteger(status)) return { outcome: 'unknown' }
  if (result !== undefined && typeof result !== 'boolean') return { outcome: 'unknown' }
  if (status === undefined && result === undefined) return { outcome: 'unknown' }
  if ((status !== undefined && status !== 0) || result === false) {
    return { outcome: 'rejected', providerStatus: status !== undefined && status !== 0 ? (status as number) : null }
  }
  return { outcome: 'accepted' }
}

// Every JSON number of a valid document rewritten as the string "#<digits>",
// so that ids above 2^53 survive JSON.parse, and every string value replaced
// by "!", so that no original string can pass for a number. Keys are kept.
export function numbersAsText(text: string): string {
  let out = ''
  for (let at = 0; at < text.length; ) {
    const char = text[at]
    if (char === '"') {
      let end = at + 1
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      let next = end + 1
      while (/\s/.test(text[next] ?? '')) next++
      out += text[next] === ':' ? text.slice(at, end + 1) : '"!"'
      at = end + 1
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))!
      out += `"#${match[0]}"`
      at += match[0].length
    } else {
      out += char
      at++
    }
  }
  return out
}

export function exactId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('#')) return null
  const digits = value.slice(1)
  return canonicalId(digits) ? digits : null
}

/**
 * Decodes one members answer. Unlike the donor, which skips a malformed kind
 * and still succeeds, a general kind that is present but not an array of
 * positive int64 numbers (null and strings included), a malformed revision
 * or one user in two kinds fails the whole answer: a partial list must never
 * read as complete. Keys other than 1..6 (and revision) are ignored.
 */
export function decodeBubbleReactionMembers(text: string): BubbleReactionMembers {
  if (parseObject(text) === null) throw new BubbleReactionReadError('malformed')
  const value = JSON.parse(numbersAsText(text)) as Record<string, unknown>
  const members = { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] } as BubbleReactionMembers['members']
  const seen = new Set<string>()
  for (const key of KIND_KEYS) {
    const raw = value[key]
    if (raw === undefined) continue
    if (!Array.isArray(raw)) throw new BubbleReactionReadError('malformed')
    for (const item of raw) {
      const id = exactId(item)
      if (id === null || seen.has(id)) throw new BubbleReactionReadError('malformed')
      seen.add(id)
      members[key].push(id)
    }
  }
  let revision: string | null = null
  if (value.revision !== undefined) {
    if (value.revision === '#0') revision = null
    else {
      revision = exactId(value.revision)
      if (revision === null) throw new BubbleReactionReadError('malformed')
    }
  }
  return { revision, members }
}

/** Reads the current members of one message once. */
export async function getBubbleReactionMembers(
  http: BubbleReactionHttp,
  chatId: string,
  logId: string,
): Promise<BubbleReactionMembers> {
  if (!canonicalId(chatId) || !canonicalId(logId)) throw new BubbleReactionReadError('invalid_request')
  const answer = await oneRequest(http, `${BASE}${chatId}/bubble/reactions/${logId}/members`, {
    method: 'GET',
    headers: { ...http.authorizedHeaders },
  })
  if (answer === null) throw new BubbleReactionReadError('transport')
  if (answer.status < 200 || answer.status >= 300) {
    throw new BubbleReactionReadError(answer.status >= 400 && answer.status < 500 ? 'rejected' : 'transport')
  }
  return decodeBubbleReactionMembers(answer.text)
}

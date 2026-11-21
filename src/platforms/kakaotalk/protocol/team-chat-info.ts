// One read of a Team Chat's own profile (the "About team" intro, its name, host
// and state) from the team service the clients call alcatraz:
// POST https://talk-pilsner.kakao.com/alcatraz/v1/chat/info {"chatId":<int64>}.
// A Regular Chat or an Open Chat room answers 404 {"code":"90001"}.
//
// Protocol facts referenced (no code taken) from libhwang50/kakaobridge
// b499c3ab7cc0db0aadd01c1aad0eeb6988035bf7 docs/protocol-notes.md §7a; see
// NOTICE.md. The request shape, the fixed host, the no-redirect deadline and
// the exact-number decoding reuse the bubble reaction owner.
//
// Read only: no edit (`/alcatraz/v1/chat/update`), invite, join or approval.
// Credentials, URLs and response bodies never enter a result or an error.

import { exactId, numbersAsText, oneRequest, type BubbleReactionHttp } from './bubble-reactions'
import { parseObject } from './media-direct'

const URL = 'https://talk-pilsner.kakao.com/alcatraz/v1/chat/info'
const CANONICAL_ID = /^[1-9]\d{0,18}$/
const MAX_SIGNED_INT64 = 9223372036854775807n
const MAX_TEXT = 4096
const NOT_TEAM_CODE = '90001'

export interface TeamChatInfo {
  chat_id: string
  name: string
  /** The intro the client calls "About team"; empty when none is set. */
  description: string
  /** The host's native user id as an exact decimal string. */
  host_id: string
  /** The service's own state, e.g. "ACTIVE"; passed through, never interpreted. */
  status: string
}

export class TeamChatInfoError extends Error {
  constructor(readonly reason: 'invalid_request' | 'not_team' | 'transport' | 'rejected' | 'malformed') {
    super(`Team chat info unavailable (${reason})`)
    this.name = 'TeamChatInfoError'
  }
}

function canonicalId(value: string): boolean {
  return CANONICAL_ID.test(value) && BigInt(value) <= MAX_SIGNED_INT64
}

function boundedString(value: unknown, allowEmpty: boolean): string | null {
  return typeof value === 'string' && value.length <= MAX_TEXT && (allowEmpty || value.length > 0) ? value : null
}

/**
 * Decodes one 200 answer for `chatId`. The chat id must be that exact number
 * (read from its digits, so an id above 2^53 is compared exactly) and the
 * host a positive int64 given as a number or a decimal string. A missing or
 * mistyped field fails the whole answer; nothing is filled in.
 */
export function decodeTeamChatInfo(text: string, chatId: string): TeamChatInfo {
  const value = parseObject(text)
  if (value === null) throw new TeamChatInfoError('malformed')
  const exact = JSON.parse(numbersAsText(text)) as Record<string, unknown>
  if (exactId(exact.chatId) !== chatId) throw new TeamChatInfoError('malformed')
  const host =
    typeof value.hostId === 'string' ? (canonicalId(value.hostId) ? value.hostId : null) : exactId(exact.hostId)
  const name = boundedString(value.name, false)
  const description = value.description === undefined || value.description === null
    ? ''
    : boundedString(value.description, true)
  const status = boundedString(value.status, false)
  if (host === null || name === null || description === null || status === null) {
    throw new TeamChatInfoError('malformed')
  }
  return { chat_id: chatId, name, description, host_id: host, status }
}

/** Reads one Team Chat's profile once; never retried here. */
export async function getTeamChatInfoOnce(http: BubbleReactionHttp, chatId: string): Promise<TeamChatInfo> {
  if (!canonicalId(chatId)) throw new TeamChatInfoError('invalid_request')
  const answer = await oneRequest(http, URL, {
    method: 'POST',
    headers: { ...http.authorizedHeaders, 'Content-Type': 'application/json' },
    body: `{"chatId":${chatId}}`,
  })
  if (answer === null) throw new TeamChatInfoError('transport')
  if (answer.status === 404) {
    const value = parseObject(answer.text)
    if (value !== null && String(value.code) === NOT_TEAM_CODE) throw new TeamChatInfoError('not_team')
    throw new TeamChatInfoError('rejected')
  }
  if (answer.status >= 400 && answer.status < 500) throw new TeamChatInfoError('rejected')
  if (answer.status !== 200) throw new TeamChatInfoError('transport')
  return decodeTeamChatInfo(answer.text, chatId)
}

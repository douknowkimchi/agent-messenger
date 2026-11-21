import { isKnownKakaoChatStringType, type KakaoChat, type KakaoOpenChatType } from './types'

export type KakaoChatKind = 'dm' | 'group' | 'open' | 'unknown'

// OpenChat-family `type` values observed on the wire. Login/chat-list data
// uses numeric codes while CHATINFO may return the protocol string tags
// `OM` / `OD`; both forms must share this single classification owner.
const OPEN_CHAT_TYPES: ReadonlySet<KakaoOpenChatType> = new Set([2, 13, 14, 15, 16, 'OM', 'OD'])

export function isOpenKakaoChatType(type: unknown): type is KakaoOpenChatType {
  return OPEN_CHAT_TYPES.has(type as KakaoOpenChatType)
}

// Protocol string tags that name a chat other than a group. A team-state meta
// on one of these does not turn it into a group.
const EXPLICIT_NON_GROUP_TYPES: ReadonlySet<unknown> = new Set(['DirectChat', 'MemoChat', 'PlusChat'])

export function isExplicitNonGroupKakaoChatType(type: unknown): boolean {
  return EXPLICIT_NON_GROUP_TYPES.has(type)
}

/**
 * Classify a KakaoTalk chat as `'dm'`, `'group'`, `'open'`, or `'unknown'`.
 *
 * REGRESSION GUARD: An earlier implementation hard-coded `0=dm`, `1=group`,
 * `2=open` on the raw `type` number. Modern KakaoTalk uses codes like `11`
 * for normal DMs and `10` for normal groups, so the old mapping silently
 * classified every real DM as `'unknown'` and bucketed it as a group. Do
 * NOT "simplify" this back to a pure type-code mapping without verifying
 * against a real KakaoTalk session.
 *
 * `'unknown'` is reserved for future string protocol drift so consumers fail
 * closed instead of silently classifying an unrecognized server value by
 * member count.
 */
export function classifyKakaoChat(chat: Pick<KakaoChat, 'type' | 'active_members' | 'team'>): KakaoChatKind {
  if (isOpenKakaoChatType(chat.type)) return 'open'
  if (typeof chat.type === 'string' && !isKnownKakaoChatStringType(chat.type)) {
    return 'unknown'
  }
  // A Team Chat is a group whatever its size: a two-person team is not the
  // 1:1 with the other member. Only the SDK's own CHATINFO read sets `team`.
  // The team-state meta is established on group (MultiChat) rooms only, so an
  // explicitly named 1:1, self or Plus chat keeps its own identity.
  if (chat.team === true && !isExplicitNonGroupKakaoChatType(chat.type)) return 'group'
  // active_members counts the logged-in user, so a 1:1 DM is exactly 2
  // (self + one other) and a "lone" room with only self is 1.
  if (chat.active_members <= 2) return 'dm'
  return 'group'
}

import { expect, it } from 'bun:test'

import type { KakaoOAuthRefreshOptions } from '@/platforms/kakaotalk/index'
import {
  classifyKakaoChat,
  CredentialManager,
  KakaoOAuthRefreshError,
  KakaoAccountCredentialsSchema,
  KakaoCredentialManager,
  KakaoChatSchema,
  KakaoConfigSchema,
  KakaoCreateDirectChatResultSchema,
  KakaoLeaveChatOnceResultSchema,
  KakaoLeaveChatResultSchema,
  KakaoMessagePageSchema,
  KakaoMessageSchema,
  KakaoSendResultSchema,
  KakaoTalkClient,
  KakaoTalkError,
  isOpenKakaoChatType,
  KakaoTalkListener,
  KakaoTalkPushMemberEventSchema,
  KakaoTalkPushMessageEventSchema,
  KakaoProfileSchema,
  KakaoTalkPushReadEventSchema,
  KakaoTypingResultSchema,
  refreshKakaoOAuthToken,
} from '@/platforms/kakaotalk/index'

it('KakaoTalkClient is exported from barrel', () => {
  expect(typeof KakaoTalkClient).toBe('function')
})

it('KakaoTalkError is exported from barrel', () => {
  expect(typeof KakaoTalkError).toBe('function')
})

it('CredentialManager is exported from barrel', () => {
  expect(typeof CredentialManager).toBe('function')
})

it('KakaoCredentialManager is exported from barrel', () => {
  expect(typeof KakaoCredentialManager).toBe('function')
})

it('KakaoTalkListener is exported from barrel', () => {
  expect(typeof KakaoTalkListener).toBe('function')
})

it('KakaoChatSchema is exported from barrel', () => {
  expect(typeof KakaoChatSchema.parse).toBe('function')
})

it('KakaoChatSchema preserves a non-empty string channel type', () => {
  for (const channelType of ['DirectChat', 'MultiChat', 'PlusChat', 'MemoChat', 'OM', 'OD', 'FutureChat']) {
    expect(
      KakaoChatSchema.parse({
        chat_id: '300',
        type: channelType,
        display_name: null,
        title: null,
        active_members: 2,
        unread_count: 0,
        last_message: null,
      }).type,
    ).toBe(channelType)
  }
  expect(() =>
    KakaoChatSchema.parse({
      chat_id: '300',
      type: '',
      display_name: null,
      title: null,
      active_members: 2,
      unread_count: 0,
      last_message: null,
    }),
  ).toThrow()
})

it('KakaoMessageSchema is exported from barrel', () => {
  expect(typeof KakaoMessageSchema.parse).toBe('function')
})

it('KakaoMessagePageSchema is exported from barrel', () => {
  expect(typeof KakaoMessagePageSchema.parse).toBe('function')
})

it('KakaoSendResultSchema is exported from barrel', () => {
  expect(typeof KakaoSendResultSchema.parse).toBe('function')
})

it('KakaoCreateDirectChatResultSchema is exported and keeps created/existing distinct', () => {
  expect(typeof KakaoCreateDirectChatResultSchema.parse).toBe('function')
  expect(KakaoCreateDirectChatResultSchema.parse({
    success: true,
    status_code: -310,
    outcome: 'existing',
    peer_id: '7',
    chat_id: '11',
  }).outcome).toBe('existing')
  expect(() => KakaoCreateDirectChatResultSchema.parse({
    success: true,
    status_code: 0,
    outcome: 'existing',
    peer_id: '7',
    chat_id: '11',
  })).toThrow()
})

it('KakaoAccountCredentialsSchema is exported from barrel', () => {
  expect(typeof KakaoAccountCredentialsSchema.parse).toBe('function')
})

it('KakaoConfigSchema is exported from barrel', () => {
  expect(typeof KakaoConfigSchema.parse).toBe('function')
})

it('KakaoTalkPushMessageEventSchema is exported from barrel', () => {
  expect(typeof KakaoTalkPushMessageEventSchema.parse).toBe('function')
})

it('KakaoTalkPushMemberEventSchema is exported from barrel', () => {
  expect(typeof KakaoTalkPushMemberEventSchema.parse).toBe('function')
})

it('KakaoTalkPushReadEventSchema is exported from barrel', () => {
  expect(typeof KakaoTalkPushReadEventSchema.parse).toBe('function')
})

it('KakaoProfileSchema is exported from barrel', () => {
  expect(typeof KakaoProfileSchema.parse).toBe('function')
})

it('classifyKakaoChat is exported from barrel', () => {
  expect(typeof classifyKakaoChat).toBe('function')
})

it('isOpenKakaoChatType is exported from barrel', () => {
  expect(isOpenKakaoChatType('OM')).toBe(true)
  expect(isOpenKakaoChatType(13)).toBe(true)
  expect(isOpenKakaoChatType('UNKNOWN')).toBe(false)
})

it('KakaoLeaveChatResultSchema is exported from barrel', () => {
  expect(typeof KakaoLeaveChatResultSchema.parse).toBe('function')
})

it('KakaoTypingResultSchema is exported from barrel', () => {
  expect(typeof KakaoTypingResultSchema.parse).toBe('function')
})

it('Kakao OAuth refresh API is exported from barrel', () => {
  expect(typeof refreshKakaoOAuthToken).toBe('function')
  expect(typeof KakaoOAuthRefreshError).toBe('function')

  const options: KakaoOAuthRefreshOptions = { timeoutMs: 5_000 }
  expect(options.timeoutMs).toBe(5_000)
})

it('KakaoLeaveChatOnceResultSchema is exported and separates left from rejected', () => {
  expect(KakaoLeaveChatOnceResultSchema.parse({ success: true, status_code: 0, outcome: 'left', chat_id: '100' }).outcome).toBe('left')
  expect(KakaoLeaveChatOnceResultSchema.parse({ success: false, status_code: -805, outcome: 'rejected', chat_id: '100' }).outcome).toBe('rejected')
  expect(() => KakaoLeaveChatOnceResultSchema.parse({ success: false, status_code: 0, outcome: 'rejected', chat_id: '100' })).toThrow()
  expect(() => KakaoLeaveChatOnceResultSchema.parse({ success: true, status_code: -805, outcome: 'left', chat_id: '100' })).toThrow()
})

import { afterEach, beforeEach, describe, expect, mock, it } from 'bun:test'

import { Long } from 'bson'

import { KakaoTalkClient, KakaoTalkError } from './client'

// Mock LocoSession at module level
const mockLogin = mock(() => Promise.resolve({}))
const mockGetChatList = mock(() => Promise.resolve({}))
const mockGetChatLogs = mock(() => Promise.resolve({}))
const mockEnterRoom = mock(() => Promise.resolve({}))
const mockGetChatInfo = mock(() => Promise.resolve({}))
const mockGetChannelInfo = mock(() => Promise.resolve({}))
const mockGetOpenLinkInfo = mock(() => Promise.resolve({}))
const mockGetAllMembers = mock(() => Promise.resolve({}))
const mockGetMembersByIds = mock(() => Promise.resolve({}))
const mockSyncMessages = mock(() => Promise.resolve({}))
const mockSendMessage = mock(() => Promise.resolve({}))
const mockSendReply = mock(() => Promise.resolve({}))
const mockCreateDirectChat = mock(() => Promise.resolve({}))
const mockJoinOpenLink = mock(() => Promise.resolve({}))
const mockMarkRead = mock(() => Promise.resolve({}))
const mockLeaveChat = mock(() => Promise.resolve({}))
const mockSendTyping = mock(() => Promise.resolve({}))
const mockClose = mock(() => {})
const mockOnClose = mock((_handler: () => void) => {})
const mockOnPush = mock((_handler: (packet: unknown) => void) => {})

mock.module('./protocol/session', () => ({
  LocoSession: class MockLocoSession {
    login = mockLogin
    getChatList = mockGetChatList
    getChatLogs = mockGetChatLogs
    enterRoom = mockEnterRoom
    getChatInfo = mockGetChatInfo
    getChannelInfo = mockGetChannelInfo
    getOpenLinkInfo = mockGetOpenLinkInfo
    getAllMembers = mockGetAllMembers
    getMembersByIds = mockGetMembersByIds
    syncMessages = mockSyncMessages
    sendMessage = mockSendMessage
    sendReply = mockSendReply
    createDirectChat = mockCreateDirectChat
    joinOpenLink = mockJoinOpenLink
    markRead = mockMarkRead
    leaveChat = mockLeaveChat
    sendTyping = mockSendTyping
    close = mockClose
    onClose = mockOnClose
    onPush = mockOnPush
  },
}))

function makeLong(n: number): { low: number; high: number } {
  return { low: n, high: 0 }
}

function memberChannelInfo(
  activeMembersCount: number,
  displayMembers: Array<Record<string, unknown>> = [],
  chatId = 100,
) {
  return {
    statusCode: 0,
    body: {
      chatInfo: {
        chatId: makeLong(chatId),
        activeMembersCount,
        displayMembers,
      },
    },
  }
}

function resetAllMocks() {
  mockLogin.mockReset()
  mockGetChatList.mockReset()
  mockGetChatLogs.mockReset()
  mockEnterRoom.mockReset()
  mockGetChatInfo.mockReset()
  mockGetChannelInfo.mockReset()
  mockGetOpenLinkInfo.mockReset()
  mockGetAllMembers.mockReset()
  mockGetMembersByIds.mockReset()
  mockSyncMessages.mockReset()
  mockSendMessage.mockReset()
  mockSendReply.mockReset()
  mockCreateDirectChat.mockReset()
  mockJoinOpenLink.mockReset()
  mockMarkRead.mockReset()
  mockLeaveChat.mockReset()
  mockSendTyping.mockReset()
  mockClose.mockReset()
  mockOnClose.mockReset()
  mockOnPush.mockReset()
}

// LOCO protocol uses plain numbers for chat.c, but Long-like objects for logIds/cursors.
// `i` and `k` are paired arrays — i[n] is the user_id, k[n] is the nickname.
const DEFAULT_LOGIN_RESULT = {
  chatDatas: [
    {
      c: 100,
      t: 1,
      k: ['Alice', 'Bob'],
      i: [1, 2],
      a: 2,
      n: 3,
      o: 1700000000,
      l: { authorId: 1, message: 'hi', sendAt: 1700000000 },
      ll: makeLong(999),
    },
    {
      c: 200,
      t: 2,
      k: ['Charlie'],
      i: [3],
      a: 1,
      n: 0,
      o: 1699999000,
      l: null,
      ll: makeLong(500),
    },
  ],
  lastTokenId: makeLong(0),
  lastChatId: makeLong(0),
  eof: true,
}

describe('KakaoTalkClient', () => {
  beforeEach(() => {
    resetAllMocks()
    // Deep-clone so tests that mutate loginResult.chatDatas (e.g. leaveChat)
    // don't leak into subsequent tests.
    mockLogin.mockResolvedValue(structuredClone(DEFAULT_LOGIN_RESULT))
    mockGetChatLogs.mockResolvedValue({ statusCode: 0, body: { status: 0, chatLogs: [], eof: true } })
    mockGetChannelInfo.mockResolvedValue({ statusCode: 0, body: { chatInfo: { chatId: 100, lastLogId: 0 } } })
    mockGetChatInfo.mockResolvedValue({ body: { l: makeLong(99999) } })
    mockSyncMessages.mockResolvedValue({ statusCode: 0, body: { status: 0, isOK: true, chatLogs: [] } })
  })

  afterEach(() => {
    expect(mockGetChatInfo).not.toHaveBeenCalled()
    resetAllMocks()
  })

  describe('chat-list display member identities', () => {
    for (const [name, input, expected] of [
      ['present', [1, '9007199254740993'], ['1', '9007199254740993']],
      ['absent', undefined, null],
      ['not an array', '1', null],
      ['empty', [], []],
      ['Long and high bit', [Long.fromString('9007199254740993'), new Long(-1, -1)],
        ['9007199254740993', '18446744073709551615']],
      ...[null, {}, { high: '1', low: 0 }, { high: 1.5, low: 0 }, Number.MAX_SAFE_INTEGER + 1,
        -1, '', '1.2', '18446744073709551616', true].map((invalid) =>
        ['invalid element ' + JSON.stringify(invalid), [1, invalid], null]),
    ] as Array<[string, unknown, string[] | null]>) {
      it(name, async () => {
        mockLogin.mockResolvedValueOnce({ ...structuredClone(DEFAULT_LOGIN_RESULT),
          chatDatas: [{ ...DEFAULT_LOGIN_RESULT.chatDatas[0], i: input }] })
        const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1' })
        const chats = await client.getChats({ resolveTitles: false })
        expect(chats[0].display_member_ids).toEqual(expected)
        client.close()
      })
    }
  })

  describe('constructor', () => {
    it('creates client with required params', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1' })
      expect(client).toBeInstanceOf(KakaoTalkClient)
      client.close()
    })

    it('defaults deviceUuid when not provided', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1' })
      expect(client).toBeInstanceOf(KakaoTalkClient)
      client.close()
    })

    it('throws KakaoTalkError with code missing_token when oauthToken is empty', async () => {
      await expect(new KakaoTalkClient().login({ oauthToken: '', userId: 'user1' })).rejects.toThrow(KakaoTalkError)
      try {
        await new KakaoTalkClient().login({ oauthToken: '', userId: 'user1' })
      } catch (e) {
        expect((e as KakaoTalkError).code).toBe('missing_token')
      }
    })

    it('throws KakaoTalkError with code missing_user_id when userId is empty', async () => {
      await expect(new KakaoTalkClient().login({ oauthToken: 'token', userId: '' })).rejects.toThrow(KakaoTalkError)
      try {
        await new KakaoTalkClient().login({ oauthToken: 'token', userId: '' })
      } catch (e) {
        expect((e as KakaoTalkError).code).toBe('missing_user_id')
      }
    })

    it('preserves invalid_access_token and never continues to LCHATLIST', async () => {
      mockLogin.mockRejectedValue(
        Object.assign(new Error('KakaoTalk LOGINLIST invalid access token (status -950)'), {
          code: 'invalid_access_token',
          serverStatus: -950,
        }),
      )
      const client = await new KakaoTalkClient().login({
        oauthToken: 'expired-access-token',
        userId: 'user1',
        deviceUuid: 'device1',
      })

      let error: unknown
      try {
        await client.getChats({ all: true })
      } catch (cause) {
        error = cause
      }

      expect(error).toBeInstanceOf(KakaoTalkError)
      expect(error).toMatchObject({ code: 'invalid_access_token', serverStatus: -950 })
      expect(mockGetChatList).not.toHaveBeenCalled()
      expect(mockClose).toHaveBeenCalledTimes(1)
    })

    it('preserves other typed LOGINLIST rejections', async () => {
      mockLogin.mockRejectedValue(
        Object.assign(new Error('KakaoTalk LOGINLIST rejected (status -777)'), {
          code: 'login_rejected',
          serverStatus: -777,
        }),
      )
      const client = await new KakaoTalkClient().login({
        oauthToken: 'rejected-access-token',
        userId: 'user1',
        deviceUuid: 'device1',
      })

      await expect(client.getChats()).rejects.toMatchObject({ code: 'login_rejected', serverStatus: -777 })
      expect(mockGetChatList).not.toHaveBeenCalled()
    })

    it('keeps interrupted LOGINLIST connections classified as login_failed', async () => {
      mockLogin.mockRejectedValue(new Error('KakaoTalk LOGINLIST transport failed: connection closed'))
      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })

      await expect(client.getChats()).rejects.toMatchObject({ code: 'login_failed' })
      expect(mockGetChatList).not.toHaveBeenCalled()
    })
  })

  describe('getChats', () => {
    it('returns formatted chats from login snapshot', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats()

      expect(chats).toHaveLength(2)
      expect(chats[0].display_name).toBe('Alice, Bob')
      expect(chats[0].title).toBeNull()
      expect(chats[0].active_members).toBe(2)
      expect(chats[0].unread_count).toBe(3)
      expect(chats[0].last_message).toEqual({
        author_id: 1,
        author_name: 'Alice',
        message: 'hi',
        sent_at: 1700000000,
      })
      expect(chats[1].display_name).toBe('Charlie')
      expect(chats[1].title).toBeNull()
      expect(chats[1].last_message).toBeNull()

      client.close()
    })

    it('preserves an unknown non-empty string type from the login snapshot', async () => {
      mockLogin.mockResolvedValue({
        ...DEFAULT_LOGIN_RESULT,
        chatDatas: [{ ...DEFAULT_LOGIN_RESULT.chatDatas[0], t: 'FutureChat' }],
      })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })

      await expect(client.getChats()).resolves.toMatchObject([{ type: 'FutureChat' }])

      client.close()
    })

    for (const invalidType of ['', true] as const) {
      it(`rejects invalid ${JSON.stringify(invalidType)} type from the login snapshot`, async () => {
        mockLogin.mockResolvedValue({
          ...DEFAULT_LOGIN_RESULT,
          chatDatas: [{ ...DEFAULT_LOGIN_RESULT.chatDatas[0], t: invalidType }],
        })

        const client = await new KakaoTalkClient().login({
          oauthToken: 'token',
          userId: 'user1',
          deviceUuid: 'device1',
        })

        await expect(client.getChats()).rejects.toMatchObject({ code: 'get_chats_failed' })

        client.close()
      })
    }

    it('populates last_message.author_name from paired chat.i / chat.k arrays', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats()

      expect(chats[0].last_message?.author_name).toBe('Alice')
    })

    it('returns null author_name when authorId is not in the paired arrays', async () => {
      const customLogin = {
        ...DEFAULT_LOGIN_RESULT,
        chatDatas: [
          {
            c: 100,
            t: 1,
            k: ['Alice'],
            i: [1],
            a: 1,
            n: 0,
            o: 1700000000,
            l: { authorId: 99, message: 'from a stranger', sendAt: 1700000000 },
            ll: makeLong(999),
          },
        ],
      }
      mockLogin.mockResolvedValue(customLogin)

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats()

      expect(chats[0].last_message?.author_id).toBe(99)
      expect(chats[0].last_message?.author_name).toBeNull()
    })

    it('returns null author_name when chat.i is missing (no paired data)', async () => {
      const customLogin = {
        ...DEFAULT_LOGIN_RESULT,
        chatDatas: [
          {
            c: 100,
            t: 1,
            k: ['Alice'],
            a: 1,
            n: 0,
            o: 1700000000,
            l: { authorId: 1, message: 'hi', sendAt: 1700000000 },
            ll: makeLong(999),
          },
        ],
      }
      mockLogin.mockResolvedValue(customLogin)

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats()

      expect(chats[0].last_message?.author_name).toBeNull()
    })

    it('does not call CHATINFO when resolveTitles is not set (default behavior preserved)', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await client.getChats()

      expect(mockGetChannelInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('resolves user-set titles via CHATINFO when resolveTitles=true', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        body: {
          chatInfo: {
            chatMetas: [
              { type: 1, content: '{"notice":"hello"}', revision: makeLong(1), updatedAt: 0 },
              { type: 3, content: 'Renamed Chat', revision: makeLong(2), updatedAt: 0 },
            ],
          },
        },
      })
      mockGetChannelInfo.mockResolvedValueOnce({
        body: {
          chatInfo: {
            chatMetas: [],
          },
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ resolveTitles: true })

      expect(mockGetChannelInfo).toHaveBeenCalledTimes(2)
      expect(chats[0].title).toBe('Renamed Chat')
      expect(chats[0].display_name).toBe('Alice, Bob')
      expect(chats[1].title).toBeNull()
      expect(chats[1].display_name).toBe('Charlie')

      client.close()
    })

    it('returns null title when chatInfo or chatMetas is missing', async () => {
      mockGetChannelInfo.mockResolvedValue({ body: {} })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ resolveTitles: true })

      for (const chat of chats) {
        expect(chat.title).toBeNull()
      }

      client.close()
    })

    it('swallows CHATINFO failures and returns null title (does not poison list)', async () => {
      mockGetChannelInfo.mockRejectedValueOnce(new Error('CHATINFO timed out'))
      mockGetChannelInfo.mockResolvedValueOnce({
        body: { chatInfo: { chatMetas: [{ type: 3, content: 'OK Title' }] } },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ resolveTitles: true })

      expect(chats).toHaveLength(2)
      expect(chats[0].title).toBeNull()
      expect(chats[1].title).toBe('OK Title')

      client.close()
    })

    it('ignores empty-string title content and returns null', async () => {
      mockGetChannelInfo.mockResolvedValue({
        body: { chatInfo: { chatMetas: [{ type: 3, content: '' }] } },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ resolveTitles: true })

      for (const chat of chats) {
        expect(chat.title).toBeNull()
      }

      client.close()
    })

    it('resolves open-chat titles via INFOLINK fallback in batch resolveTitles=true path', async () => {
      // Mixed login snapshot: regular chat (uses CHATINFO TITLE meta), open chat
      // with TITLE meta (CHATINFO only), open chat without TITLE meta (CHATINFO
      // empty + INFOLINK fallback). Verifies the batch path wires open-chat
      // fallback correctly — previously only the single-chat getChatTitle()
      // path was covered.
      const mixedLogin = {
        chatDatas: [
          {
            c: 100,
            t: 1,
            k: ['Alice'],
            i: [1],
            a: 1,
            n: 0,
            o: 1700000003,
            l: null,
            ll: makeLong(1),
          },
          {
            c: 500,
            t: 'OM',
            li: makeLong(7777),
            k: ['User1'],
            i: [10],
            a: 1,
            n: 0,
            o: 1700000002,
            l: null,
            ll: makeLong(2),
          },
          {
            c: 600,
            t: 'OD',
            li: makeLong(8888),
            k: ['User2'],
            i: [20],
            a: 1,
            n: 0,
            o: 1700000001,
            l: null,
            ll: makeLong(3),
          },
        ],
        lastTokenId: makeLong(0),
        lastChatId: makeLong(0),
        eof: true,
      }
      mockLogin.mockResolvedValue(mixedLogin)

      // CHATINFO is fired in parallel for all 3 chats; mock by chatId so order
      // doesn't matter (Promise.all resolves in fire order, not array order).
      mockGetChannelInfo.mockImplementation((chatId: { low: number; high: number }) => {
        switch (chatId.low) {
          case 100:
            return Promise.resolve({ body: { chatInfo: { chatMetas: [{ type: 3, content: 'Regular Title' }] } } })
          case 500:
            return Promise.resolve({ body: { chatInfo: { chatMetas: [{ type: 3, content: 'Open With Title' }] } } })
          case 600:
            return Promise.resolve({ body: { chatInfo: { chatMetas: [] } } })
          default:
            return Promise.resolve({ body: {} })
        }
      })
      mockGetOpenLinkInfo.mockResolvedValueOnce({ body: { ols: [{ ln: 'Open Link Name' }] } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ resolveTitles: true })

      const byId = Object.fromEntries(chats.map((c) => [c.chat_id, c]))
      expect(byId['100'].title).toBe('Regular Title')
      expect(byId['500'].title).toBe('Open With Title')
      expect(byId['600'].title).toBe('Open Link Name')

      // INFOLINK fires only for the open chat that lacked a TITLE meta — not
      // for the regular chat (skipped by isOpenChat) and not for the open
      // chat that already had a TITLE (skipped by short-circuit).
      expect(mockGetOpenLinkInfo).toHaveBeenCalledTimes(1)
      const [linkIds] = mockGetOpenLinkInfo.mock.calls[0] as [Array<{ low: number; high: number }>]
      expect(linkIds).toHaveLength(1)
      expect(linkIds[0]).toMatchObject({ low: 8888, high: 0 })

      client.close()
    })

    it('resolves an open-chat title when the link id arrives as a promoted number', async () => {
      // The packet decoder promotes an int64 that fits in 53 bits to a
      // number, which is how real open-link ids reach the chat list.
      mockLogin.mockResolvedValue({
        chatDatas: [
          {
            c: 600,
            t: 'OM',
            li: 8888,
            k: ['User2'],
            i: [20],
            a: 1,
            n: 0,
            o: 1700000001,
            l: null,
            ll: makeLong(3),
          },
        ],
        lastTokenId: makeLong(0),
        lastChatId: makeLong(0),
        eof: true,
      })
      mockGetChannelInfo.mockResolvedValue({ body: { chatInfo: { chatMetas: [] } } })
      mockGetOpenLinkInfo.mockResolvedValueOnce({ body: { ols: [{ ln: 'Promoted Link Name' }] } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ resolveTitles: true })

      expect(chats).toHaveLength(1)
      expect(chats[0].title).toBe('Promoted Link Name')
      expect(mockGetOpenLinkInfo).toHaveBeenCalledTimes(1)
      const [linkIds] = mockGetOpenLinkInfo.mock.calls[0] as [Array<{ low: number; high: number }>]
      expect(linkIds).toHaveLength(1)
      expect(linkIds[0]).toBeInstanceOf(Long)
      expect(linkIds[0]).toMatchObject({ low: 8888, high: 0 })

      client.close()
    })

    for (const invalidLinkId of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      it(`does not contact INFOLINK for an unusable numeric link id ${invalidLinkId}`, async () => {
        mockLogin.mockResolvedValue({
          chatDatas: [
            {
              c: 600,
              t: 'OM',
              li: invalidLinkId,
              k: ['User2'],
              i: [20],
              a: 1,
              n: 0,
              o: 1700000001,
              l: null,
              ll: makeLong(3),
            },
          ],
          lastTokenId: makeLong(0),
          lastChatId: makeLong(0),
          eof: true,
        })
        mockGetChannelInfo.mockResolvedValue({ body: { chatInfo: { chatMetas: [] } } })

        const client = await new KakaoTalkClient().login({
          oauthToken: 'token',
          userId: 'user1',
          deviceUuid: 'device1',
        })
        const chats = await client.getChats({ resolveTitles: true })

        expect(chats[0].title).toBeNull()
        expect(mockGetOpenLinkInfo).not.toHaveBeenCalled()

        client.close()
      })
    }

    it('sorts chats by recency (o field descending)', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats()

      // chat 100 has o=1700000000, chat 200 has o=1699999000
      expect(chats[0].chat_id).toBe('100')
      expect(chats[1].chat_id).toBe('200')

      client.close()
    })

    it('filters by search term', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ search: 'alice' })

      expect(chats).toHaveLength(1)
      expect(chats[0].display_name).toBe('Alice, Bob')

      client.close()
    })

    it('falls back to LCHATLIST when login snapshot is empty (new device)', async () => {
      // given — LOGINLIST returns empty chatDatas with eof:true (new device scenario)
      const emptyLoginResult = {
        chatDatas: [],
        lastTokenId: makeLong(0),
        lastChatId: makeLong(0),
        eof: true,
      }
      mockLogin.mockResolvedValue(emptyLoginResult)

      mockGetChatList.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatDatas: [
            {
              c: 100,
              t: 1,
              k: ['Alice', 'Bob'],
              a: 2,
              n: 3,
              o: 1700000000,
              l: { authorId: 1, message: 'hi', sendAt: 1700000000 },
              ll: makeLong(999),
            },
            {
              c: 200,
              t: 2,
              k: ['Charlie'],
              a: 1,
              n: 0,
              o: 1699999000,
              l: null,
              ll: makeLong(500),
            },
          ],
          lastTokenId: makeLong(1),
          lastChatId: makeLong(200),
          eof: true,
        },
      })

      // when — default chat list (no --all flag)
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats()

      // then — fetched via LCHATLIST despite eof:true and no --all
      expect(chats).toHaveLength(2)
      expect(mockGetChatList).toHaveBeenCalledTimes(1)
      expect(chats[0].display_name).toBe('Alice, Bob')
      expect(chats[1].display_name).toBe('Charlie')

      client.close()
    })

    it('does not call LCHATLIST when login snapshot has chats', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await client.getChats()

      expect(mockGetChatList).not.toHaveBeenCalled()

      client.close()
    })

    it('paginates when all=true and not eof', async () => {
      const loginResult = {
        ...DEFAULT_LOGIN_RESULT,
        eof: false,
      }
      mockLogin.mockResolvedValue(loginResult)

      mockGetChatList.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatDatas: [
            {
              c: 300,
              t: 1,
              k: ['Dave'],
              a: 1,
              n: 0,
              o: 1698000000,
              l: null,
              ll: makeLong(100),
            },
          ],
          lastTokenId: makeLong(1),
          lastChatId: makeLong(300),
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ all: true })

      expect(chats).toHaveLength(3)
      expect(mockGetChatList).toHaveBeenCalledTimes(1)

      client.close()
    })

    it('deduplicates chats by id', async () => {
      const loginResult = {
        ...DEFAULT_LOGIN_RESULT,
        eof: false,
      }
      mockLogin.mockResolvedValue(loginResult)

      // Return a chat with same ID as login result
      mockGetChatList.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatDatas: [
            {
              c: 100, // Same as first login chat
              t: 1,
              k: ['Alice', 'Bob'],
              a: 2,
              n: 0,
              o: 1700000000,
              l: null,
              ll: makeLong(999),
            },
          ],
          lastTokenId: makeLong(1),
          lastChatId: makeLong(100),
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ all: true })

      expect(chats).toHaveLength(2) // Not 3 — deduped
      client.close()
    })

    it('normalizes Long-like chat ids from LCHATLIST pages', async () => {
      const loginResult = {
        ...DEFAULT_LOGIN_RESULT,
        eof: false,
      }
      mockLogin.mockResolvedValue(loginResult)

      mockGetChatList.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatDatas: [
            {
              c: makeLong(300),
              t: 1,
              k: ['Dave'],
              i: [4],
              a: 1,
              n: 0,
              o: 1698000000,
              l: { authorId: 4, message: 'from paginated chat', sendAt: 1698000000 },
              ll: makeLong(100),
            },
          ],
          lastTokenId: makeLong(1),
          lastChatId: makeLong(300),
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ all: true })

      const paginatedChat = chats.find((chat) => chat.chat_id === '300')
      expect(paginatedChat?.chat_id).toBe('300')
      expect(paginatedChat?.display_name).toBe('Dave')
      expect(paginatedChat?.last_message?.author_name).toBe('Dave')
      expect(chats.some((chat) => chat.chat_id === '[object Object]')).toBe(false)

      client.close()
    })

    it('collects every LCHATLIST page until an explicit EOF', async () => {
      mockLogin.mockResolvedValue({ ...DEFAULT_LOGIN_RESULT, eof: false })
      mockGetChatList
        .mockResolvedValueOnce({
          statusCode: 0,
          body: {
            status: 0,
            chatDatas: [
              {
                c: 300,
                t: 1,
                k: ['Dave'],
                i: [4],
                a: 1,
                n: 0,
                o: 1698000000,
                l: null,
                ll: makeLong(100),
              },
            ],
            lastTokenId: makeLong(1),
            lastChatId: makeLong(300),
            eof: false,
          },
        })
        .mockResolvedValueOnce({
          statusCode: 0,
          body: {
            status: 0,
            chatDatas: [
              {
                c: 400,
                t: 1,
                k: ['Erin'],
                i: [5],
                a: 1,
                n: 0,
                o: 1697000000,
                l: null,
                ll: makeLong(90),
              },
            ],
            lastTokenId: makeLong(2),
            lastChatId: makeLong(400),
            eof: true,
          },
        })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ all: true })

      expect(chats.map((chat) => chat.chat_id)).toEqual(['100', '200', '300', '400'])
      expect(mockGetChatList).toHaveBeenCalledTimes(2)

      client.close()
    })

    it('fails closed when LCHATLIST has a nonzero response status', async () => {
      mockLogin.mockResolvedValue({ ...DEFAULT_LOGIN_RESULT, eof: false })
      mockGetChatList.mockResolvedValueOnce({
        statusCode: 503,
        body: { status: 0, chatDatas: [], lastTokenId: makeLong(1), lastChatId: makeLong(300), eof: true },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChats({ all: true })).rejects.toMatchObject({
        code: 'get_chats_failed',
        responseFailureKind: 'provider_rejection',
        serverStatus: 503,
      })

      client.close()
    })

    it('fails closed on an empty non-EOF LCHATLIST page', async () => {
      mockLogin.mockResolvedValue({ ...DEFAULT_LOGIN_RESULT, eof: false })
      mockGetChatList.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatDatas: [], lastTokenId: makeLong(1), lastChatId: makeLong(300), eof: false },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChats({ all: true })).rejects.toMatchObject({ code: 'get_chats_failed' })
      expect(mockGetChatList).toHaveBeenCalledTimes(1)

      client.close()
    })

    it('fails closed when LCHATLIST reaches the page cap without EOF', async () => {
      mockLogin.mockResolvedValue({ ...DEFAULT_LOGIN_RESULT, eof: false })
      let page = 0
      mockGetChatList.mockImplementation(async () => {
        page++
        return {
          statusCode: 0,
          body: {
            status: 0,
            chatDatas: [
              {
                c: 1000 + page,
                t: 1,
                k: [`Room ${page}`],
                i: [1000 + page],
                a: 1,
                n: 0,
                o: 1600000000 - page,
                l: null,
                ll: makeLong(page),
              },
            ],
            lastTokenId: makeLong(page),
            lastChatId: makeLong(1000 + page),
            eof: false,
          },
        }
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChats({ all: true })).rejects.toMatchObject({ code: 'get_chats_failed' })
      expect(mockGetChatList).toHaveBeenCalledTimes(50)

      client.close()
    })

    it('preserves non-all search compatibility on an empty non-EOF page', async () => {
      mockLogin.mockResolvedValue({ ...DEFAULT_LOGIN_RESULT, eof: false })
      mockGetChatList.mockResolvedValueOnce({
        body: { chatDatas: [], lastTokenId: makeLong(1), lastChatId: makeLong(300), eof: false },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chats = await client.getChats({ search: 'Alice' })

      expect(chats.map((chat) => chat.chat_id)).toEqual(['100'])
      expect(mockGetChatList).toHaveBeenCalledTimes(1)

      client.close()
    })

    it('wraps errors as KakaoTalkError', async () => {
      mockLogin.mockRejectedValue(new Error('Connection refused'))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await expect(client.getChats()).rejects.toThrow(KakaoTalkError)

      // Reset for second attempt
      mockLogin.mockRejectedValue(new Error('Connection refused'))
      try {
        await client.getChats()
      } catch (e) {
        expect((e as KakaoTalkError).code).toBe('login_failed')
      }

      client.close()
    })

    it('exposes getChatTitle() for single-chat title resolution', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        body: { chatInfo: { chatMetas: [{ type: 3, content: 'Direct Lookup' }] } },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const title = await client.getChatTitle('100')

      expect(title).toBe('Direct Lookup')
      expect(mockGetChannelInfo).toHaveBeenCalledTimes(1)

      client.close()
    })

    it('getChatTitle() returns null on CHATINFO failure', async () => {
      mockGetChannelInfo.mockRejectedValueOnce(new Error('Network error'))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const title = await client.getChatTitle('100')

      expect(title).toBeNull()

      client.close()
    })

    it('getChatTitle() returns null on invalid chatId without contacting LOCO', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const title = await client.getChatTitle('not-a-number')

      expect(title).toBeNull()
      expect(mockGetChannelInfo).not.toHaveBeenCalled()
      expect(mockLogin).not.toHaveBeenCalled()

      client.close()
    })

    it('falls back to INFOLINK link name for open chats with no TITLE meta', async () => {
      const openChatLogin = {
        chatDatas: [
          {
            c: 500,
            t: 'OM',
            li: makeLong(7777),
            k: ['User1', 'User2'],
            i: [10, 20],
            a: 2,
            n: 0,
            o: 1700000000,
            l: null,
            ll: makeLong(1),
          },
        ],
        lastTokenId: makeLong(0),
        lastChatId: makeLong(0),
        eof: true,
      }
      mockLogin.mockResolvedValue(openChatLogin)
      mockGetChannelInfo.mockResolvedValueOnce({ body: { chatInfo: { chatMetas: [] } } })
      mockGetOpenLinkInfo.mockResolvedValueOnce({ body: { ols: [{ ln: 'Open Group Title' }] } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const title = await client.getChatTitle('500')

      expect(title).toBe('Open Group Title')
      expect(mockGetChannelInfo).toHaveBeenCalledTimes(1)
      expect(mockGetOpenLinkInfo).toHaveBeenCalledTimes(1)

      client.close()
    })

    it('does not call INFOLINK for non-open chats (regular MultiChat)', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ body: { chatInfo: { chatMetas: [] } } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const title = await client.getChatTitle('100')

      expect(title).toBeNull()
      expect(mockGetOpenLinkInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('does not call INFOLINK when CHATINFO already returned a TITLE meta', async () => {
      const openChatLogin = {
        chatDatas: [
          {
            c: 500,
            t: 'OM',
            li: makeLong(7777),
            k: [],
            i: [],
            a: 1,
            n: 0,
            o: 1700000000,
            l: null,
            ll: makeLong(1),
          },
        ],
        lastTokenId: makeLong(0),
        lastChatId: makeLong(0),
        eof: true,
      }
      mockLogin.mockResolvedValue(openChatLogin)
      mockGetChannelInfo.mockResolvedValueOnce({
        body: { chatInfo: { chatMetas: [{ type: 3, content: 'User Set Title' }] } },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const title = await client.getChatTitle('500')

      expect(title).toBe('User Set Title')
      expect(mockGetOpenLinkInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('returns null when INFOLINK fails for open chats', async () => {
      const openChatLogin = {
        chatDatas: [
          {
            c: 500,
            t: 'OD',
            li: makeLong(7777),
            k: [],
            i: [],
            a: 1,
            n: 0,
            o: 1700000000,
            l: null,
            ll: makeLong(1),
          },
        ],
        lastTokenId: makeLong(0),
        lastChatId: makeLong(0),
        eof: true,
      }
      mockLogin.mockResolvedValue(openChatLogin)
      mockGetChannelInfo.mockResolvedValueOnce({ body: { chatInfo: { chatMetas: [] } } })
      mockGetOpenLinkInfo.mockRejectedValueOnce(new Error('INFOLINK timeout'))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const title = await client.getChatTitle('500')

      expect(title).toBeNull()

      client.close()
    })

    it('returns null when open chat has no link id (li missing)', async () => {
      const openChatLogin = {
        chatDatas: [
          {
            c: 500,
            t: 'OM',
            k: [],
            i: [],
            a: 1,
            n: 0,
            o: 1700000000,
            l: null,
            ll: makeLong(1),
          },
        ],
        lastTokenId: makeLong(0),
        lastChatId: makeLong(0),
        eof: true,
      }
      mockLogin.mockResolvedValue(openChatLogin)
      mockGetChannelInfo.mockResolvedValueOnce({ body: { chatInfo: { chatMetas: [] } } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const title = await client.getChatTitle('500')

      expect(title).toBeNull()
      expect(mockGetOpenLinkInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('wraps getChatList failure as KakaoTalkError with code get_chats_failed', async () => {
      const loginResult = { ...DEFAULT_LOGIN_RESULT, eof: false }
      mockLogin.mockResolvedValue(loginResult)
      mockGetChatList.mockRejectedValue(new Error('Network error'))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getChats({ all: true })
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('get_chats_failed')
      }

      client.close()
    })
  })

  describe('getChat', () => {
    it('returns one fully normalized late chat from read-only CHATINFO', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            chatId: makeLong(300),
            type: 11,
            left: false,
            activeMembersCount: 2,
            newMessageCount: 4,
            invalidNewMessageCount: false,
            lastLogId: makeLong(77),
            lastSeenLogId: makeLong(73),
            lastChatLog: {
              logId: makeLong(77),
              authorId: 42,
              type: 1,
              message: 'latest',
              sendAt: 1700000077,
            },
            displayMembers: [
              { userId: makeLong(42), nickName: 'Alice' },
              { userId: makeLong(43), nickName: 'Bob' },
            ],
            chatMetas: [{ type: 3, content: 'Late room' }],
            pushAlert: true,
          },
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const chat = await client.getChat('300')

      expect(chat).toEqual({
        chat_id: '300',
        type: 11,
        display_name: 'Alice, Bob',
        display_member_ids: ['42', '43'],
        title: 'Late room',
        active_members: 2,
        unread_count: 4,
        last_message: {
          author_id: 42,
          author_name: 'Alice',
          message: 'latest',
          sent_at: 1700000077,
        },
      })

      client.close()
    })

    it('classifies an explicit CHATINFO header rejection without exposing response contents', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: 403, body: {} })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChat('300')).rejects.toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'provider_rejection',
        responseFailureKind: 'provider_rejection',
        responseStatusSource: 'packet',
        serverStatus: 403,
      })

      client.close()
    })

    it('classifies an explicit CHATINFO body rejection and preserves its numeric status', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: 0, body: { status: -404 } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChat('300')).rejects.toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'provider_rejection',
        responseFailureKind: 'provider_rejection',
        responseStatusSource: 'body',
        serverStatus: -404,
      })

      client.close()
    })

    it('does not expose rejected CHATINFO body contents through public error metadata', async () => {
      const secretSentinel = 'secret-sentinel-do-not-emit'
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: -404, secret: secretSentinel },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      let error: unknown
      try {
        await client.getChat('300')
      } catch (cause) {
        error = cause
      }

      expect(error).toBeInstanceOf(KakaoTalkError)
      const publicError = error as KakaoTalkError
      expect(publicError).toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'provider_rejection',
        responseFailureKind: 'provider_rejection',
        responseStatusSource: 'body',
        serverStatus: -404,
      })
      expect(publicError.message).not.toContain(secretSentinel)
      expect(JSON.stringify(publicError)).not.toContain(secretSentinel)
      expect(JSON.stringify(publicError.cause)).not.toContain(secretSentinel)

      client.close()
    })

    it('classifies synthetic connection-close status -1 as transient rather than provider rejection', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: -1, body: { error: 'connection closed' } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChat('300')).rejects.toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'synthetic_connection_close',
        responseFailureKind: 'transient_or_unknown',
        responseStatusSource: 'packet',
        serverStatus: -1,
      })

      client.close()
    })

    it('does not classify status -1 with a nonmatching body as a synthetic connection close', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: -1, body: { error: 'provider rejected' } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChat('300')).rejects.toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'provider_rejection',
        responseFailureKind: 'provider_rejection',
        responseStatusSource: 'packet',
        serverStatus: -1,
      })

      client.close()
    })

    it('classifies a thrown CHATINFO transport failure as transient or unknown', async () => {
      const secretSentinel = 'secret-transport-body-do-not-emit'
      mockGetChannelInfo.mockRejectedValueOnce(
        Object.assign(new Error('socket unavailable'), { body: { secret: secretSentinel } }),
      )

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      let error: unknown
      try {
        await client.getChat('300')
      } catch (cause) {
        error = cause
      }

      expect(error).toBeInstanceOf(KakaoTalkError)
      expect(error).toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'transport_or_unknown',
        responseFailureKind: 'transient_or_unknown',
      })
      const serialized = JSON.stringify(error)
      expect(serialized).not.toContain(secretSentinel)
      expect(serialized).not.toContain('body')
      expect(serialized).not.toContain('message')
      expect(serialized).not.toContain('cause')

      client.close()
    })

    it('classifies a successful CHATINFO response without chatInfo as structurally absent', async () => {
      const secretSentinel = 'secret-chat-body-do-not-emit'
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: 0, body: { secret: secretSentinel } })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      let error: unknown
      try {
        await client.getChat('300')
      } catch (cause) {
        error = cause
      }

      expect(error).toBeInstanceOf(KakaoTalkError)
      expect(error).toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'chat_info_absent',
        responseFailureKind: 'transient_or_unknown',
      })
      const serialized = JSON.stringify(error)
      expect(serialized).not.toContain(secretSentinel)
      expect(serialized).not.toContain('body')
      expect(serialized).not.toContain('message')
      expect(serialized).not.toContain('cause')

      client.close()
    })

    it('classifies a successful CHATINFO response with null chatInfo as structurally absent', async () => {
      const secretSentinel = 'secret-null-chat-body-do-not-emit'
      const chatIdSentinel = '987654321012345678'
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: { chatInfo: null, secret: secretSentinel },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      let error: unknown
      try {
        await client.getChat(chatIdSentinel)
      } catch (cause) {
        error = cause
      }

      expect(error).toBeInstanceOf(KakaoTalkError)
      expect(error).toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'chat_info_absent',
        responseFailureKind: 'transient_or_unknown',
      })
      const serialized = JSON.stringify(error)
      expect(serialized).not.toContain(secretSentinel)
      expect(serialized).not.toContain('body')
      expect(serialized).not.toContain('message')
      expect(serialized).not.toContain('cause')
      expect(serialized).not.toContain('chatId')
      expect(serialized).not.toContain(chatIdSentinel)

      client.close()
    })

    it('classifies exact CHATINFO left=true as structurally absent without exposing response contents', async () => {
      const secretSentinel = 'secret-left-chat-body-do-not-emit'
      const nativeChatIdSentinel = '987654321'
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            left: true,
            chatId: makeLong(Number(nativeChatIdSentinel)),
            secret: secretSentinel,
          },
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      let error: unknown
      try {
        await client.getChat(nativeChatIdSentinel)
      } catch (cause) {
        error = cause
      }

      expect(error).toBeInstanceOf(KakaoTalkError)
      expect(error).toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'chat_info_absent',
        responseFailureKind: 'transient_or_unknown',
      })
      const publicError = error as KakaoTalkError
      const serialized = JSON.stringify(publicError)
      expect(publicError.message).not.toContain(secretSentinel)
      expect(publicError.message).not.toContain(nativeChatIdSentinel)
      expect(serialized).not.toContain(secretSentinel)
      expect(serialized).not.toContain(nativeChatIdSentinel)

      client.close()
    })

    for (const [label, chatInfo] of [
      ['mismatched chatId', { left: true, chatId: makeLong(301) }],
      ['missing chatId', { left: true }],
      ['invalid chatId', { left: true, chatId: { invalid: true } }],
    ] as const) {
      it(`does not classify CHATINFO left=true with ${label} as structurally absent`, async () => {
        mockGetChannelInfo.mockResolvedValueOnce({
          statusCode: 0,
          body: { chatInfo },
        })

        const client = await new KakaoTalkClient().login({
          oauthToken: 'token',
          userId: 'user1',
          deviceUuid: 'device1',
        })

        await expect(client.getChat('300')).rejects.toMatchObject({
          code: 'get_chat_failed',
          getChatFailureReason: 'transport_or_unknown',
          responseFailureKind: 'transient_or_unknown',
        })

        client.close()
      })
    }

    for (const [label, chatInfo] of [
      ['left=false', { left: false }],
      ['left missing', {}],
      ['left nonboolean', { left: 'true' }],
    ] as const) {
      it(`does not classify malformed successful CHATINFO with ${label} as structurally absent`, async () => {
        mockGetChannelInfo.mockResolvedValueOnce({
          statusCode: 0,
          body: { chatInfo },
        })

        const client = await new KakaoTalkClient().login({
          oauthToken: 'token',
          userId: 'user1',
          deviceUuid: 'device1',
        })

        await expect(client.getChat('300')).rejects.toMatchObject({
          code: 'get_chat_failed',
          getChatFailureReason: 'transport_or_unknown',
          responseFailureKind: 'transient_or_unknown',
        })

        client.close()
      })
    }

    it('classifies malformed successful CHATINFO chatInfo as transport or unknown', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: { chatInfo: { chatId: makeLong(300) } },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChat('300')).rejects.toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'transport_or_unknown',
        responseFailureKind: 'transient_or_unknown',
      })

      client.close()
    })

    for (const openChatType of ['OM', 'OD'] as const) {
      it(`preserves ${openChatType} and falls back to INFOLINK when CHATINFO has no title`, async () => {
        mockGetChannelInfo.mockResolvedValueOnce({
          statusCode: 0,
          body: {
            chatInfo: {
              chatId: makeLong(300),
              type: openChatType,
              activeMembersCount: 2,
              newMessageCount: 0,
              invalidNewMessageCount: false,
              lastLogId: makeLong(77),
              lastSeenLogId: makeLong(73),
              lastChatLog: null,
              displayMembers: [
                { userId: makeLong(42), nickName: 'Alice' },
                { userId: makeLong(43), nickName: 'Bob' },
              ],
              chatMetas: [],
              li: makeLong(7777),
              pushAlert: true,
            },
          },
        })
        mockGetOpenLinkInfo.mockResolvedValueOnce({ body: { ols: [{ ln: 'Open Group Title' }] } })

        const client = await new KakaoTalkClient().login({
          oauthToken: 'token',
          userId: 'user1',
          deviceUuid: 'device1',
        })
        const chat = await client.getChat('300')

        expect(chat).toEqual({
          chat_id: '300',
          type: openChatType,
          display_name: 'Alice, Bob',
          display_member_ids: ['42', '43'],
          title: 'Open Group Title',
          active_members: 2,
          unread_count: 0,
          last_message: null,
          link_id: '7777',
        })
        expect(mockGetOpenLinkInfo).toHaveBeenCalledTimes(1)

        client.close()
      })
    }

    it('falls back to INFOLINK for a numeric open-chat code', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            chatId: makeLong(300),
            type: 13,
            activeMembersCount: 2,
            newMessageCount: 0,
            invalidNewMessageCount: false,
            lastLogId: makeLong(77),
            lastSeenLogId: makeLong(73),
            lastChatLog: null,
            displayMembers: [],
            chatMetas: [],
            li: makeLong(7777),
            pushAlert: true,
          },
        },
      })
      mockGetOpenLinkInfo.mockResolvedValueOnce({ body: { ols: [{ ln: 'Numeric Open Title' }] } })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      const chat = await client.getChat('300')

      expect(chat.type).toBe(13)
      expect(chat.title).toBe('Numeric Open Title')
      expect(mockGetOpenLinkInfo).toHaveBeenCalledTimes(1)

      client.close()
    })

    it('falls back to INFOLINK when CHATINFO carries the link id as a promoted number', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            chatId: makeLong(300),
            type: 'OM',
            activeMembersCount: 2,
            newMessageCount: 0,
            invalidNewMessageCount: false,
            lastLogId: makeLong(77),
            lastSeenLogId: makeLong(73),
            lastChatLog: null,
            displayMembers: [],
            chatMetas: [],
            li: 7777,
            pushAlert: true,
          },
        },
      })
      mockGetOpenLinkInfo.mockResolvedValueOnce({ body: { ols: [{ ln: 'Exact Promoted Title' }] } })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      const chat = await client.getChat('300')

      expect(chat.title).toBe('Exact Promoted Title')
      expect(mockGetOpenLinkInfo).toHaveBeenCalledTimes(1)
      const [linkIds] = mockGetOpenLinkInfo.mock.calls[0] as [Array<{ low: number; high: number }>]
      expect(linkIds[0]).toBeInstanceOf(Long)
      expect(linkIds[0]).toMatchObject({ low: 7777, high: 0 })

      client.close()
    })

    for (const normalChatType of ['DirectChat', 'MultiChat', 'PlusChat', 'MemoChat'] as const) {
      it(`preserves donor-defined ${normalChatType} without contacting INFOLINK`, async () => {
        mockGetChannelInfo.mockResolvedValueOnce({
          statusCode: 0,
          body: {
            chatInfo: {
              chatId: makeLong(300),
              type: normalChatType,
              activeMembersCount: 2,
              newMessageCount: 0,
              invalidNewMessageCount: false,
              lastLogId: makeLong(1),
              lastSeenLogId: makeLong(0),
              displayMembers: [],
              chatMetas: [],
              li: makeLong(7777),
              pushAlert: true,
            },
          },
        })

        const client = await new KakaoTalkClient().login({
          oauthToken: 'token',
          userId: 'user1',
          deviceUuid: 'device1',
        })

        await expect(client.getChat('300')).resolves.toEqual({
          chat_id: '300',
          type: normalChatType,
          display_name: null,
          display_member_ids: [],
          title: null,
          active_members: 2,
          unread_count: 0,
          last_message: null,
        })
        expect(mockGetOpenLinkInfo).not.toHaveBeenCalled()

        client.close()
      })
    }

    it('rejects an empty string CHATINFO type without contacting INFOLINK', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            chatId: makeLong(300),
            type: '',
            activeMembersCount: 2,
            newMessageCount: 0,
            invalidNewMessageCount: false,
            lastLogId: makeLong(1),
            lastSeenLogId: makeLong(0),
            displayMembers: [],
            chatMetas: [],
            pushAlert: true,
          },
        },
      })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })

      await expect(client.getChat('300')).rejects.toMatchObject({
        code: 'get_chat_failed',
        getChatFailureReason: 'transport_or_unknown',
        responseFailureKind: 'transient_or_unknown',
      })
      expect(mockGetOpenLinkInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('preserves an unknown non-empty string CHATINFO type without contacting INFOLINK', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            chatId: makeLong(300),
            type: 'UnknownChat',
            activeMembersCount: 2,
            newMessageCount: 0,
            invalidNewMessageCount: false,
            lastLogId: makeLong(1),
            lastSeenLogId: makeLong(0),
            displayMembers: [],
            chatMetas: [],
            pushAlert: true,
          },
        },
      })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })

      await expect(client.getChat('300')).resolves.toEqual({
        chat_id: '300',
        type: 'UnknownChat',
        display_name: null,
        display_member_ids: [],
        title: null,
        active_members: 2,
        unread_count: 0,
        last_message: null,
      })
      expect(mockGetOpenLinkInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('rejects a CHATINFO response bound to a different chat id', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            chatId: makeLong(999),
            type: 11,
            activeMembersCount: 2,
            newMessageCount: 0,
            invalidNewMessageCount: false,
            lastLogId: makeLong(1),
            lastSeenLogId: makeLong(0),
            displayMembers: [],
            chatMetas: [],
            pushAlert: true,
          },
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChat('300')).rejects.toMatchObject({ code: 'get_chat_failed' })

      client.close()
    })

    it('rejects an invalid chat id before opening a LOCO session', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.getChat('not-a-number')).rejects.toMatchObject({ code: 'invalid_chat_id' })
      expect(mockLogin).not.toHaveBeenCalled()
      expect(mockGetChannelInfo).not.toHaveBeenCalled()

      client.close()
    })
  })

  describe('getMessages', () => {
    it('returns a lossless forward page without discarding the oldest messages', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatLogs: Array.from({ length: 5 }, (_, index) => ({
            logId: makeLong(index + 1),
            chatId: 100,
            type: 1,
            authorId: 42,
            message: `message-${index + 1}`,
            sendAt: 1700000000 + index,
          })),
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const page = await client.getMessagePage('100', { count: 2 })

      expect(page.messages.map((message) => message.log_id)).toEqual(['1', '2'])
      expect(page.next_cursor).toBe('2')
      expect(page.complete).toBe(false)

      client.close()
    })

    it('returns a complete forward page when the protocol page is exhausted', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatLogs: [
            { logId: makeLong(11), chatId: 100, type: 1, authorId: 42, message: 'eleven', sendAt: 11 },
            { logId: makeLong(10), chatId: 100, type: 1, authorId: 42, message: 'ten', sendAt: 10 },
          ],
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const page = await client.getMessagePage('100', { from: '9', count: 10 })

      expect(page.messages.map((message) => message.log_id)).toEqual(['10', '11'])
      expect(page.next_cursor).toBe('11')
      expect(page.complete).toBe(true)

      client.close()
    })

    it('continues exclusively after the supplied cursor when the server repeats it', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatLogs: [
            { logId: makeLong(2), chatId: 100, type: 1, authorId: 42, message: 'repeat', sendAt: 2 },
            { logId: makeLong(3), chatId: 100, type: 1, authorId: 42, message: 'three', sendAt: 3 },
            { logId: makeLong(4), chatId: 100, type: 1, authorId: 42, message: 'four', sendAt: 4 },
          ],
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const page = await client.getMessagePage('100', { from: '2', count: 10 })

      expect(page.messages.map((message) => message.log_id)).toEqual(['3', '4'])
      expect(page.next_cursor).toBe('4')
      expect(page.complete).toBe(true)

      client.close()
    })

    it('does not report completion when the protocol makes no cursor progress', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: [], eof: false },
      })
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            chatId: makeLong(100),
            type: 11,
            activeMembersCount: 2,
            newMessageCount: 0,
            invalidNewMessageCount: false,
            lastLogId: makeLong(999),
            lastSeenLogId: makeLong(0),
            displayMembers: [],
            chatMetas: [],
            pushAlert: true,
          },
        },
      })
      mockSyncMessages.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: [], isOK: false },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const page = await client.getMessagePage('100', { from: '9', count: 10 })

      expect(page).toEqual({ messages: [], next_cursor: null, complete: false })

      client.close()
    })

    it('uses read-only CHATINFO to paginate a late room missing from the login snapshot', async () => {
      mockLogin.mockResolvedValueOnce({ ...structuredClone(DEFAULT_LOGIN_RESULT), chatDatas: [] })
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: [], eof: true },
      })
      mockGetChannelInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatInfo: {
            chatId: makeLong(300),
            type: 11,
            activeMembersCount: 2,
            newMessageCount: 1,
            invalidNewMessageCount: false,
            lastLogId: makeLong(12),
            lastSeenLogId: makeLong(0),
            displayMembers: [],
            chatMetas: [],
            pushAlert: true,
          },
        },
      })
      mockSyncMessages.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          isOK: true,
          chatLogs: [{ logId: makeLong(12), chatId: 300, type: 1, authorId: 42, message: 'late', sendAt: 12 }],
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const page = await client.getMessagePage('300', { from: '11', count: 10 })

      expect(page.messages.map((message) => message.log_id)).toEqual(['12'])
      expect(page.next_cursor).toBe('12')
      expect(page.complete).toBe(true)
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      expect(mockSyncMessages.mock.calls[0]?.[2]?.toString()).toBe('11')
      expect(mockSyncMessages.mock.calls[0]?.[3]?.toString()).toBe('12')

      client.close()
    })

    it('falls back to SYNCMSG when MCHATLOGS succeeds with an empty result', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: 0, body: { chatInfo: { chatId: 100, lastLogId: 10 } } })
      const loginResult = structuredClone(DEFAULT_LOGIN_RESULT)
      loginResult.chatDatas[0]!.ll = makeLong(10)
      mockLogin.mockResolvedValueOnce(loginResult)
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: [], eof: true },
      })
      mockSyncMessages.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          isOK: true,
          chatLogs: [
            { logId: makeLong(10), chatId: 100, type: 1, authorId: 42, message: 'fallback', sendAt: 1700000001 },
          ],
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100')

      expect(messages).toHaveLength(1)
      expect(messages[0]?.message).toBe('fallback')
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      expect(mockSyncMessages).toHaveBeenCalledTimes(1)
      expect(mockSyncMessages.mock.calls[0]?.[3]?.toString()).toBe('10')

      client.close()
    })

    it('does not enter or sync a room when the MCHATLOGS cursor is already current', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: 0, body: { chatInfo: { chatId: 100, lastLogId: 999 } } })
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: [], eof: true },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100', { from: '999' })

      expect(messages).toEqual([])
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      expect(mockSyncMessages).not.toHaveBeenCalled()

      client.close()
    })

    it('uses fresh CHATINFO for SYNCMSG without entering the room', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: 0, body: { chatInfo: { chatId: 100, lastLogId: 10 } } })
      const loginResult = structuredClone(DEFAULT_LOGIN_RESULT)
      loginResult.chatDatas[0]!.ll = makeLong(10)
      mockLogin.mockResolvedValueOnce(loginResult)
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: [], eof: true },
      })
      mockSyncMessages.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          isOK: true,
          chatLogs: [
            { logId: makeLong(10), chatId: 100, type: 1, authorId: 42, message: 'incremental', sendAt: 1700000001 },
          ],
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100', { from: '9' })

      expect(messages).toHaveLength(1)
      expect(messages[0]?.message).toBe('incremental')
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      expect(mockSyncMessages.mock.calls[0]?.[2]?.toString()).toBe('9')
      expect(mockSyncMessages.mock.calls[0]?.[3]?.toString()).toBe('10')

      client.close()
    })

    it('uses fresh CHATINFO when the primary chat-list watermark is missing', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: 0, body: { chatInfo: { chatId: 100, lastLogId: 12 } } })
      const loginResult = structuredClone(DEFAULT_LOGIN_RESULT)
      const chat = loginResult.chatDatas[0]! as Record<string, unknown>
      delete chat.ll
      chat.l = { logId: makeLong(12) }
      mockLogin.mockResolvedValueOnce(loginResult)
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: [], eof: true },
      })
      mockSyncMessages.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          isOK: true,
          chatLogs: [
            { logId: makeLong(12), chatId: 100, type: 1, authorId: 42, message: 'last-log', sendAt: 1700000001 },
          ],
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100', { from: '11' })

      expect(messages).toHaveLength(1)
      expect(messages[0]?.message).toBe('last-log')
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      expect(mockSyncMessages.mock.calls[0]?.[2]?.toString()).toBe('11')
      expect(mockSyncMessages.mock.calls[0]?.[3]?.toString()).toBe('12')

      client.close()
    })

    it('rejects unknown history when neither login nor CHATINFO provides a watermark', async () => {
      mockGetChannelInfo.mockResolvedValueOnce({ statusCode: 0, body: { chatInfo: { chatId: 100 } } })
      mockLogin.mockResolvedValueOnce({ ...structuredClone(DEFAULT_LOGIN_RESULT), chatDatas: [] })
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: [], eof: true },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await expect(client.getMessages('100')).rejects.toMatchObject({ code: 'get_messages_failed' })
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      expect(mockSyncMessages).not.toHaveBeenCalled()

      client.close()
    })

    it('returns formatted messages', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatLogs: [
            { logId: makeLong(10), chatId: 100, type: 1, authorId: 42, message: 'hello', sendAt: 1700000001 },
            { logId: makeLong(11), chatId: 100, type: 1, authorId: 43, message: 'world', sendAt: 1700000002 },
          ],
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100')

      expect(messages).toHaveLength(2)
      expect(messages[0]).toEqual({
        log_id: '10',
        type: 1,
        author_id: 42,
        author_name: null,
        message: 'hello',
        attachment: null,
        sent_at: 1700000001,
      })
      expect(messages[1]).toEqual({
        log_id: '11',
        type: 1,
        author_id: 43,
        author_name: null,
        message: 'world',
        attachment: null,
        sent_at: 1700000002,
      })

      client.close()
    })

    it('resolves author_name for known members from the chat list cache', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatLogs: [
            { logId: makeLong(1), chatId: 100, type: 1, authorId: 1, message: 'from Alice', sendAt: 100 },
            { logId: makeLong(2), chatId: 100, type: 1, authorId: 2, message: 'from Bob', sendAt: 200 },
            { logId: makeLong(3), chatId: 100, type: 1, authorId: 99, message: 'from a stranger', sendAt: 300 },
          ],
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      // Trigger login so the cache is populated from DEFAULT_LOGIN_RESULT
      await client.getChats()
      const messages = await client.getMessages('100')

      expect(messages[0].author_name).toBe('Alice')
      expect(messages[1].author_name).toBe('Bob')
      expect(messages[2].author_name).toBeNull()

      client.close()
    })

    it('respects count option', async () => {
      const logs = Array.from({ length: 50 }, (_, i) => ({
        logId: makeLong(i + 1),
        chatId: 100,
        type: 1,
        authorId: 1,
        message: `msg-${i}`,
        sendAt: 1700000000 + i,
      }))

      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatLogs: logs, eof: true },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100', { count: 5 })

      expect(messages).toHaveLength(5)
      // Should return the LAST 5 (most recent)
      expect(messages[0].message).toBe('msg-45')
      expect(messages[4].message).toBe('msg-49')

      client.close()
    })

    it('sorts messages by sent_at ascending', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatLogs: [
            { logId: makeLong(2), chatId: 100, type: 1, authorId: 1, message: 'second', sendAt: 200 },
            { logId: makeLong(1), chatId: 100, type: 1, authorId: 1, message: 'first', sendAt: 100 },
          ],
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100')

      expect(messages[0].message).toBe('first')
      expect(messages[1].message).toBe('second')

      client.close()
    })

    it('parses chatLog.attachment JSON for photo messages', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatLogs: [
            {
              logId: makeLong(20),
              chatId: 100,
              type: 2,
              authorId: 42,
              message: '사진',
              sendAt: 1700000010,
              attachment: '{"k":"path/to/img.jpg","w":1320,"h":2868,"mt":"image/jpeg"}',
            },
          ],
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100')

      expect(messages[0].attachment).toEqual({
        k: 'path/to/img.jpg',
        w: 1320,
        h: 2868,
        mt: 'image/jpeg',
      })

      client.close()
    })

    it('returns null attachment for malformed JSON', async () => {
      mockGetChatLogs.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatLogs: [
            {
              logId: makeLong(21),
              chatId: 100,
              type: 1,
              authorId: 42,
              message: 'broken',
              sendAt: 1700000011,
              attachment: 'not-json',
            },
          ],
          eof: true,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const messages = await client.getMessages('100')

      expect(messages[0].attachment).toBeNull()

      client.close()
    })
  })

  describe('open profile 1:1 (getOpenLink, joinOpenDirectOnce)', () => {
    const big = (value: bigint) => Long.fromString(value.toString(), true)
    const owner = 2n ** 53n + 9n
    const link = '9223372036854775001'
    const login = () => new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })

    it('reads exactly one profile link and names its type, activation and exact owner', async () => {
      mockGetOpenLinkInfo.mockResolvedValueOnce({
        statusCode: 0,
        body: { ols: [{ li: Long.fromString(link), lt: 1, ac: true, ln: 'Profile', olu: { userId: big(owner), nn: 'Owner' } }] },
      })
      const client = await login()
      await expect(client.getOpenLink(link)).resolves.toEqual({
        link_id: link, link_type: 1, active: true, owner_user_id: owner.toString(), any_profile_allowed: null,
      })
      const [ids] = mockGetOpenLinkInfo.mock.calls[0] as [Long[]]
      expect(ids.map(String)).toEqual([link])
      client.close()
    })

    for (const [label, ols] of [
      ['no link', []],
      ['two links', [{ li: Long.fromString(link), lt: 1, ac: true, olu: { userId: 5 } }, { li: Long.fromString(link), lt: 1, ac: true, olu: { userId: 5 } }]],
      ['another link', [{ li: Long.fromString('77'), lt: 1, ac: true, olu: { userId: 5 } }]],
      ['no type', [{ li: Long.fromString(link), ac: true, olu: { userId: 5 } }]],
      ['no activation', [{ li: Long.fromString(link), lt: 1, olu: { userId: 5 } }]],
      ['no owner', [{ li: Long.fromString(link), lt: 1, ac: true }]],
    ] as const) {
      it(`refuses an INFOLINK answer with ${label}`, async () => {
        mockGetOpenLinkInfo.mockResolvedValueOnce({ statusCode: 0, body: { ols } })
        const client = await login()
        await expect(client.getOpenLink(link)).rejects.toMatchObject({ code: 'get_open_link_failed' })
        client.close()
      })
    }

    it('joins once with the open profile and returns the answered room, link and owner unverified', async () => {
      mockJoinOpenLink.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          status: 0,
          chatRoom: { chatId: Long.fromString('9007199254740995'), type: 'OD' },
          ol: { li: Long.fromString(link), olu: { userId: big(owner) } },
          olu: { userId: 1, ptp: 16 },
        },
      })
      const client = await login()
      await expect(client.joinOpenDirectOnce(link, { kind: 'open_profile', link_id: '4401' })).resolves.toEqual({
        success: true, status_code: 0, outcome: 'joined', chat_id: '9007199254740995', chat_type: 'OD',
        link_id: link, owner_user_id: owner.toString(),
      })
      expect(mockJoinOpenLink).toHaveBeenCalledTimes(1)
      const [li, profile] = mockJoinOpenLink.mock.calls[0] as [Long, { ptp: number; pli?: Long }]
      expect(li.toString()).toBe(link)
      expect(profile.ptp).toBe(16)
      expect(profile.pli!.toString()).toBe('4401')
      client.close()
    })

    it('joins with the main profile only as { ptp: 1 }', async () => {
      mockJoinOpenLink.mockResolvedValueOnce({ statusCode: 0, body: { status: 0, chatRoom: { chatId: 5 }, ol: {} } })
      const client = await login()
      await expect(client.joinOpenDirectOnce(link, { kind: 'main' })).resolves.toMatchObject({ outcome: 'joined', chat_id: '5', owner_user_id: null })
      expect(mockJoinOpenLink.mock.calls[0][1]).toEqual({ ptp: 1 })
      client.close()
    })

    it('returns a non-zero body status as a definite refusal', async () => {
      mockJoinOpenLink.mockResolvedValueOnce({ statusCode: 0, body: { status: -324 } })
      const client = await login()
      await expect(client.joinOpenDirectOnce(link, { kind: 'main' })).resolves.toEqual({
        success: false, status_code: -324, outcome: 'rejected', chat_id: null, chat_type: null, link_id: null, owner_user_id: null,
      })
      expect(mockJoinOpenLink).toHaveBeenCalledTimes(1)
      client.close()
    })

    for (const [label, response] of [
      ['the synthetic connection close', { statusCode: -1, body: { error: 'connection closed' } }],
    ] as const) {
      it(`classifies ${label} as unknown and never asks again`, async () => {
        mockJoinOpenLink.mockResolvedValueOnce(response)
        const client = await login()
        await expect(client.joinOpenDirectOnce(link, { kind: 'main' })).rejects.toMatchObject({
          code: 'join_open_direct_unknown', responseFailureKind: 'transient_or_unknown',
        })
        expect(mockJoinOpenLink).toHaveBeenCalledTimes(1)
        client.close()
      })
    }

    it('keeps what an answer named when its header contradicts body status 0, as unknown', async () => {
      mockJoinOpenLink.mockResolvedValueOnce({
        statusCode: -500,
        body: { status: 0, chatRoom: { chatId: 5, type: 'OD' }, ol: { li: Long.fromString(link), olu: { userId: 77 } } },
      })
      const client = await login()
      await expect(client.joinOpenDirectOnce(link, { kind: 'main' })).resolves.toEqual({
        success: false, status_code: null, outcome: 'unknown', chat_id: '5', chat_type: 'OD', link_id: link, owner_user_id: '77',
      })
      expect(mockJoinOpenLink).toHaveBeenCalledTimes(1)
      client.close()
    })

    it('keeps what an answer without a body status named, as unknown', async () => {
      mockJoinOpenLink.mockResolvedValueOnce({
        statusCode: 0,
        body: { chatRoom: { chatId: 5 }, ol: { li: Long.fromString(link), olu: { userId: 77 } } },
      })
      const client = await login()
      await expect(client.joinOpenDirectOnce(link, { kind: 'main' })).resolves.toEqual({
        success: false, status_code: null, outcome: 'unknown', chat_id: '5', chat_type: null, link_id: link, owner_user_id: '77',
      })
      expect(mockJoinOpenLink).toHaveBeenCalledTimes(1)
      client.close()
    })

    it('keeps the link and owner a join named even when its room id is unusable', async () => {
      mockJoinOpenLink.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: 0, chatRoom: { chatId: 0, type: 'OD' }, ol: { li: Long.fromString(link), olu: { userId: 77 } } },
      })
      const client = await login()
      await expect(client.joinOpenDirectOnce(link, { kind: 'main' })).resolves.toEqual({
        success: true, status_code: 0, outcome: 'joined', chat_id: null, chat_type: 'OD', link_id: link, owner_user_id: '77',
      })
      expect(mockJoinOpenLink).toHaveBeenCalledTimes(1)
      client.close()
    })

    it('does not replay JOINLINK after the captured session closes during the operation', async () => {
      mockJoinOpenLink.mockImplementationOnce(async () => {
        const closeHandler = mockOnClose.mock.calls.at(-1)?.[0] as (() => void) | undefined
        closeHandler?.()
        throw new Error('Synthetic socket close')
      })
      const client = await login()
      await expect(client.joinOpenDirectOnce(link, { kind: 'main' })).rejects.toMatchObject({ code: 'join_open_direct_unknown' })
      expect(mockJoinOpenLink).toHaveBeenCalledTimes(1)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })

    for (const [linkId, profile] of [['0', { kind: 'main' }], [link, { kind: 'anon' }],
      [link, { kind: 'open_profile', link_id: '01' }]] as const) {
      it(`refuses ${linkId}/${JSON.stringify(profile)} before session acquisition`, async () => {
        const client = await login()
        await expect(client.joinOpenDirectOnce(linkId, profile as never)).rejects.toThrow()
        expect(mockJoinOpenLink).not.toHaveBeenCalled()
        expect(mockLogin).not.toHaveBeenCalled()
        client.close()
      })
    }
  })

  describe('createDirectChatOnce', () => {
    it('dispatches CREATE once and returns a newly created full-width chat id', async () => {
      mockCreateDirectChat.mockResolvedValueOnce({
        statusCode: 0,
        body: { chatId: Long.fromString('9007199254740993') },
      })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })

      await expect(client.createDirectChatOnce('9223372036854775807')).resolves.toEqual({
        success: true,
        status_code: 0,
        outcome: 'created',
        peer_id: '9223372036854775807',
        chat_id: '9007199254740993',
      })
      expect(mockCreateDirectChat).toHaveBeenCalledTimes(1)
      const [peer] = mockCreateDirectChat.mock.calls[0] as [Long]
      expect(peer).toBeInstanceOf(Long)
      expect(peer.toString()).toBe('9223372036854775807')
      client.close()
    })

    it('treats -310 with chatId as the existing direct room', async () => {
      mockCreateDirectChat.mockResolvedValueOnce({
        statusCode: -310,
        body: { chatId: Long.fromString('459750513901477') },
      })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })

      await expect(client.createDirectChatOnce('9007199254740993')).resolves.toEqual({
        success: true,
        status_code: -310,
        outcome: 'existing',
        peer_id: '9007199254740993',
        chat_id: '459750513901477',
      })
      expect(mockCreateDirectChat).toHaveBeenCalledTimes(1)
      client.close()
    })

    it('returns a definite provider rejection without inventing a room id', async () => {
      mockCreateDirectChat.mockResolvedValueOnce({ statusCode: -500, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })

      await expect(client.createDirectChatOnce('7')).resolves.toEqual({
        success: false,
        status_code: -500,
        outcome: 'rejected',
        peer_id: '7',
        chat_id: null,
      })
      expect(mockCreateDirectChat).toHaveBeenCalledTimes(1)
      client.close()
    })

    for (const chatId of [undefined, 0, '01', '9223372036854775808', new Long(-1, -1)]) {
      it(`classifies successful CREATE with unusable chatId ${String(chatId)} as unknown and never retries`, async () => {
        mockCreateDirectChat.mockResolvedValueOnce({ statusCode: 0, body: { chatId } })
        const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })

        await expect(client.createDirectChatOnce('7')).rejects.toMatchObject({
          code: 'create_direct_chat_unknown',
          responseFailureKind: 'transient_or_unknown',
        })
        expect(mockCreateDirectChat).toHaveBeenCalledTimes(1)
        client.close()
      })
    }

    it('does not replay CREATE after the captured session closes during the operation', async () => {
      mockCreateDirectChat.mockImplementationOnce(async () => {
        const closeHandler = mockOnClose.mock.calls.at(-1)?.[0] as (() => void) | undefined
        closeHandler?.()
        throw new Error('Synthetic socket close')
      })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })

      await expect(client.createDirectChatOnce('7')).rejects.toMatchObject({ code: 'create_direct_chat_unknown' })
      expect(mockCreateDirectChat).toHaveBeenCalledTimes(1)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })

    for (const peerId of ['', '0', '01', '-1', '1.0', '9223372036854775808']) {
      it(`rejects non-canonical peer id ${JSON.stringify(peerId)} before session acquisition`, async () => {
        const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })

        await expect(client.createDirectChatOnce(peerId)).rejects.toMatchObject({ code: 'invalid_peer_id' })
        expect(mockCreateDirectChat).not.toHaveBeenCalled()
        expect(mockLogin).not.toHaveBeenCalled()
        client.close()
      })
    }
  })

  describe('sendTextOnce on an already prepared session', () => {
    async function prepared() {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })
      await client.acquireSession()
      return client
    }

    it('sends one WRITE with an exact 64-bit room id and accepts its log id', async () => {
      const client = await prepared()
      mockSendMessage.mockResolvedValueOnce({ statusCode: 0, body: { logId: Long.fromString('9007199254740993'), sendAt: 1700000099 } })
      await expect(client.sendTextOnce('9223372036854775807', 'synthetic one shot')).resolves.toMatchObject({
        success: true, status_code: 0, chat_id: '9223372036854775807', log_id: '9007199254740993',
      })
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
      expect((mockSendMessage.mock.calls[0][0] as Long).toString()).toBe('9223372036854775807')
      expect(mockLogin).toHaveBeenCalledTimes(1)
      expect(mockEnterRoom).not.toHaveBeenCalled()
      expect(mockMarkRead).not.toHaveBeenCalled()
      client.close()
    })

    it('refuses a cold authenticated client before acquiring a session or writing', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: '1', deviceUuid: 'device1' })
      await expect(client.sendTextOnce('100', 'synthetic')).rejects.toMatchObject({ code: 'send_session_not_ready' })
      expect(mockLogin).not.toHaveBeenCalled()
      expect(mockSendMessage).not.toHaveBeenCalled()
      client.close()
    })

    it('keeps an explicit provider refusal distinct from a lost response', async () => {
      const client = await prepared()
      mockSendMessage.mockResolvedValueOnce({ statusCode: -500, body: {} })
      await expect(client.sendTextOnce('100', 'synthetic')).resolves.toMatchObject({ success: false, status_code: -500 })
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })

    for (const [label, response] of [
      ['connection-close sentinel', { statusCode: -1, body: { error: 'connection closed' } }],
      ['missing status', { body: {} }],
      ['missing identity', { statusCode: 0, body: {} }],
      ['wrong room', { statusCode: 0, body: { logId: makeLong(42), chatId: makeLong(200) } }],
    ]) {
      it(`does not call a ${label} a provider rejection or replay the WRITE`, async () => {
        const client = await prepared()
        mockSendMessage.mockResolvedValueOnce(response)
        await expect(client.sendTextOnce('100', 'synthetic')).rejects.toMatchObject({ code: 'send_message_failed' })
        expect(mockSendMessage).toHaveBeenCalledTimes(1)
        expect(mockLogin).toHaveBeenCalledTimes(1)
        client.close()
      })
    }

    it('does not reconnect or replay when the captured session closes after WRITE', async () => {
      const client = await prepared()
      mockSendMessage.mockImplementationOnce(async () => {
        const closeHandler = mockOnClose.mock.calls.at(-1)?.[0] as (() => void) | undefined
        closeHandler?.()
        throw new Error('Synthetic socket closed after WRITE')
      })
      await expect(client.sendTextOnce('100', 'synthetic')).rejects.toMatchObject({ code: 'send_message_failed' })
      await expect(client.sendTextOnce('100', 'next explicit attempt on closed session')).rejects.toMatchObject({ code: 'send_session_not_ready' })
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })

    for (const room of ['', '0', '-1', '01', '1.0', '9223372036854775808']) {
      it(`rejects invalid room ${JSON.stringify(room)} before WRITE`, async () => {
        const client = await prepared()
        await expect(client.sendTextOnce(room, 'synthetic')).rejects.toThrow()
        expect(mockSendMessage).not.toHaveBeenCalled()
        expect(mockLogin).toHaveBeenCalledTimes(1)
        client.close()
      })
    }
  })

  describe('sendMessage', () => {
    it('returns send result on success', async () => {
      mockSendMessage.mockResolvedValueOnce({
        statusCode: 0,
        body: { logId: makeLong(42), sendAt: 1700000099 },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const result = await client.sendMessage('100', 'hello')

      expect(result).toEqual({
        success: true,
        status_code: 0,
        chat_id: '100',
        log_id: '42',
        sent_at: 1700000099,
      })

      client.close()
    })

    it('reports failure when statusCode is non-zero', async () => {
      mockSendMessage.mockResolvedValueOnce({
        statusCode: -500,
        body: { logId: makeLong(0), sendAt: 0 },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const result = await client.sendMessage('100', 'hello')

      expect(result.success).toBe(false)
      expect(result.status_code).toBe(-500)

      client.close()
    })

    it('wraps transport errors as KakaoTalkError', async () => {
      mockSendMessage.mockRejectedValue(new Error('Socket closed'))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await expect(client.sendMessage('100', 'hello')).rejects.toThrow(KakaoTalkError)

      mockSendMessage.mockRejectedValue(new Error('Socket closed'))
      try {
        await client.sendMessage('100', 'hello')
      } catch (e) {
        expect((e as KakaoTalkError).code).toBe('send_message_failed')
      }

      client.close()
    })

    it('routes to sendReply with a built reply extra when replyTo is given', async () => {
      // given
      mockSendReply.mockResolvedValueOnce({ statusCode: 0, body: { logId: makeLong(50), sendAt: 1700000100 } })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when
      const result = await client.sendMessage('100', 'replying', {
        replyTo: { log_id: '42', author_id: 7, message: 'original', type: 1 },
      })

      // then
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(mockSendReply).toHaveBeenCalledTimes(1)
      const [, text, extra] = mockSendReply.mock.calls[0] as [unknown, string, Record<string, unknown>]
      expect(text).toBe('replying')
      expect(extra).toEqual({
        attach_only: false,
        attach_type: 1,
        src_logId: '42',
        src_userId: 7,
        src_message: 'original',
        src_type: 1,
        src_mentions: [],
        mentions: [],
      })
      expect(result).toEqual({
        success: true,
        status_code: 0,
        chat_id: '100',
        log_id: '50',
        sent_at: 1700000100,
      })

      client.close()
    })

    it('mirrors the source message type into attach_type/src_type', async () => {
      // given
      mockSendReply.mockResolvedValueOnce({ statusCode: 0, body: { logId: makeLong(51), sendAt: 1700000101 } })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when — replying to a photo (type 2)
      await client.sendMessage('100', 'nice pic', {
        replyTo: { log_id: '99', author_id: 3, message: 'photo', type: 2 },
      })

      // then
      const [, , extra] = mockSendReply.mock.calls[0] as [unknown, string, Record<string, unknown>]
      expect(extra.attach_type).toBe(2)
      expect(extra.src_type).toBe(2)

      client.close()
    })
  })

  describe('markRead', () => {
    it('calls session.markRead with parsed chatId/watermark and no linkId for normal chat', async () => {
      // given
      mockMarkRead.mockResolvedValueOnce({ statusCode: 0, body: { status: 0 } })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when
      const result = await client.markRead('100', '42')

      // then
      expect(mockMarkRead).toHaveBeenCalledTimes(1)
      const [chatIdArg, watermarkArg, linkIdArg] = mockMarkRead.mock.calls[0] as [
        { toString(): string },
        { toString(): string },
        unknown,
      ]
      expect(chatIdArg.toString()).toBe('100')
      expect(watermarkArg.toString()).toBe('42')
      expect(linkIdArg).toBeUndefined()
      expect(result).toEqual({ success: true, status_code: 0, chat_id: '100', watermark: '42' })

      client.close()
    })

    it('forwards linkId when caller passes it (open chat)', async () => {
      // given
      mockMarkRead.mockResolvedValueOnce({ statusCode: 0, body: { status: 0 } })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when
      await client.markRead('200', '999', { linkId: '77777' })

      // then
      const [, , linkIdArg] = mockMarkRead.mock.calls[0] as [unknown, unknown, { toString(): string }]
      expect(linkIdArg).toBeDefined()
      expect(linkIdArg.toString()).toBe('77777')

      client.close()
    })

    it('reports success when body.status is absent (treated as 0)', async () => {
      // given
      mockMarkRead.mockResolvedValueOnce({ statusCode: 0, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when
      const result = await client.markRead('100', '42')

      // then
      expect(result).toEqual({ success: true, status_code: 0, chat_id: '100', watermark: '42' })

      client.close()
    })

    it('reports failure from body.status (not transport statusCode) - the open-chat-missing-link case', async () => {
      // given
      mockMarkRead.mockResolvedValueOnce({ statusCode: 0, body: { status: -500 } })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when
      const result = await client.markRead('100', '42')

      // then
      expect(result).toEqual({ success: false, status_code: -500, chat_id: '100', watermark: '42' })

      client.close()
    })

    it('throws (so executeWithReconnect retries) on transport-level statusCode != 0', async () => {
      // given - simulates LocoConnection.handleClose synthetic packet
      mockMarkRead.mockRejectedValue(new Error('NOTIREAD failed: statusCode=-1'))
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when / then
      try {
        await client.markRead('100', '42')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('mark_read_failed')
      }

      client.close()
    })

    it('treats synthetic disconnect packet (statusCode: -1) as transport failure (throws)', async () => {
      // given
      mockMarkRead.mockResolvedValueOnce({ statusCode: -1, body: { error: 'connection closed' } })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when / then
      try {
        await client.markRead('100', '42')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('mark_read_failed')
      }

      client.close()
    })

    it('throws KakaoTalkError(invalid_chat_id) for non-numeric chatId', async () => {
      // given
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when / then
      try {
        await client.markRead('not-a-number', '42')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_chat_id')
      }

      client.close()
    })

    it('throws KakaoTalkError(invalid_log_id) for non-numeric logId', async () => {
      // given
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when / then
      try {
        await client.markRead('100', 'not-a-number')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_log_id')
      }

      client.close()
    })

    it('throws KakaoTalkError(invalid_link_id) for non-numeric linkId', async () => {
      // given
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when / then
      try {
        await client.markRead('100', '42', { linkId: 'not-a-number' })
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_link_id')
      }

      client.close()
    })

    it('wraps transport errors as KakaoTalkError(mark_read_failed)', async () => {
      // given
      mockMarkRead.mockRejectedValue(new Error('Socket closed'))
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // when / then
      try {
        await client.markRead('100', '42')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('mark_read_failed')
      }

      client.close()
    })
  })

  describe('leaveChatOnce', () => {
    it('dispatches LEAVE once, reports left and evicts the chat from this login list', async () => {
      mockLeaveChat.mockResolvedValueOnce({ statusCode: 0, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      expect(await client.getChats()).toHaveLength(2)

      await expect(client.leaveChatOnce('100')).resolves.toEqual({
        success: true, status_code: 0, outcome: 'left', chat_id: '100',
      })
      expect(mockLeaveChat).toHaveBeenCalledTimes(1)
      const [chat] = mockLeaveChat.mock.calls[0] as unknown as [Long]
      expect(chat).toBeInstanceOf(Long)
      expect(chat.toString()).toBe('100')
      const after = await client.getChats()
      expect(after.map((value) => value.chat_id)).toEqual(['200'])
      client.close()
    })

    it('returns a definite provider rejection and keeps the chat', async () => {
      mockLeaveChat.mockResolvedValueOnce({ statusCode: -805, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.leaveChatOnce('100')).resolves.toEqual({
        success: false, status_code: -805, outcome: 'rejected', chat_id: '100',
      })
      expect(mockLeaveChat).toHaveBeenCalledTimes(1)
      expect(await client.getChats()).toHaveLength(2)
      client.close()
    })

    for (const response of [
      { statusCode: -1, body: { error: 'connection closed' } },
      { statusCode: undefined, body: {} },
      { statusCode: 1.5, body: {} },
    ]) {
      it(`classifies acknowledgement ${JSON.stringify(response.statusCode)} as unknown and never retries`, async () => {
        mockLeaveChat.mockResolvedValueOnce(response)
        const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

        await expect(client.leaveChatOnce('100')).rejects.toMatchObject({
          code: 'leave_chat_unknown',
          responseFailureKind: 'transient_or_unknown',
        })
        expect(mockLeaveChat).toHaveBeenCalledTimes(1)
        expect(mockLogin).toHaveBeenCalledTimes(1)
        client.close()
      })
    }

    it('does not replay LEAVE after the captured session closes during the operation', async () => {
      const closeHandlers: Array<() => void> = []
      mockOnClose.mockImplementation((handler: () => void) => {
        closeHandlers.push(handler)
      })
      mockLeaveChat.mockImplementationOnce(() => {
        closeHandlers[0]?.()
        return Promise.resolve({ statusCode: -1, body: { error: 'connection closed' } })
      })
      mockLeaveChat.mockResolvedValueOnce({ statusCode: 0, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await expect(client.leaveChatOnce('100')).rejects.toMatchObject({ code: 'leave_chat_unknown' })
      expect(mockLeaveChat).toHaveBeenCalledTimes(1)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })

    for (const chatId of ['', '0', '01', '-1', '1.0', 'not-a-number', '9223372036854775808']) {
      it(`rejects non-canonical chat id ${JSON.stringify(chatId)} before dispatch`, async () => {
        const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

        await expect(client.leaveChatOnce(chatId)).rejects.toMatchObject({ code: 'invalid_chat_id' })
        expect(mockLeaveChat).not.toHaveBeenCalled()
        client.close()
      })
    }
  })
  describe('leaveChat', () => {
    it('calls session.leaveChat with parsed chatId and returns success', async () => {
      mockLeaveChat.mockResolvedValueOnce({ statusCode: 0, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      const result = await client.leaveChat('100')

      expect(result).toEqual({ success: true, status_code: 0, chat_id: '100' })
      expect(mockLeaveChat).toHaveBeenCalledWith(expect.objectContaining({ low: 100, high: 0 }))

      client.close()
    })

    it('treats synthetic disconnect packet (statusCode: -1) as transport failure (throws)', async () => {
      mockLeaveChat.mockResolvedValueOnce({ statusCode: -1, body: { error: 'connection closed' } })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      try {
        await client.leaveChat('100')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('leave_chat_failed')
      }

      client.close()
    })

    it('evicts the departed chat from getChats cache', async () => {
      mockLeaveChat.mockResolvedValueOnce({ statusCode: 0, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      const before = await client.getChats()
      expect(before).toHaveLength(2)

      await client.leaveChat('100')

      const after = await client.getChats()
      expect(after).toHaveLength(1)
      expect(after[0].chat_id).toBe('200')

      client.close()
    })

    it('reconnects and retries leaveChat after silent disconnect (full executeWithReconnect path)', async () => {
      const closeHandlers: Array<() => void> = []
      mockOnClose.mockImplementation((handler: () => void) => {
        closeHandlers.push(handler)
      })

      mockLeaveChat.mockImplementationOnce(() => {
        const handler = closeHandlers[0]
        if (handler) handler()
        return Promise.resolve({ statusCode: -1, body: { error: 'connection closed' } })
      })
      mockLeaveChat.mockResolvedValueOnce({ statusCode: 0, body: {} })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const result = await client.leaveChat('100')

      expect(result.success).toBe(true)
      expect(mockLeaveChat).toHaveBeenCalledTimes(2)
      expect(mockLogin).toHaveBeenCalledTimes(2)

      client.close()
    })

    it('throws KakaoTalkError(invalid_chat_id) for non-numeric chatId', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      try {
        await client.leaveChat('not-a-number')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_chat_id')
      }

      client.close()
    })

    it('wraps transport errors as KakaoTalkError(leave_chat_failed)', async () => {
      mockLeaveChat.mockRejectedValue(new Error('Socket closed'))
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      try {
        await client.leaveChat('100')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('leave_chat_failed')
      }

      client.close()
    })
  })

  describe('sendTyping', () => {
    it('forwards parsed chatId to session.sendTyping and reports success on statusCode 0', async () => {
      mockSendTyping.mockResolvedValueOnce({ statusCode: 0, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      const result = await client.sendTyping('12345')

      expect(mockSendTyping).toHaveBeenCalledTimes(1)
      const [chatIdArg, linkIdArg] = mockSendTyping.mock.calls[0] as [{ toString(): string }, unknown]
      expect(chatIdArg.toString()).toBe('12345')
      expect(linkIdArg).toBeUndefined()
      expect(result).toEqual({ success: true, status_code: 0, chat_id: '12345' })

      client.close()
    })

    it('passes linkId through when provided (open-chat typing)', async () => {
      mockSendTyping.mockResolvedValueOnce({ statusCode: 0, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      await client.sendTyping('12345', { linkId: '77777' })

      const [, linkIdArg] = mockSendTyping.mock.calls[0] as [unknown, { toString(): string }]
      expect(linkIdArg).toBeDefined()
      expect(linkIdArg.toString()).toBe('77777')

      client.close()
    })

    it('throws KakaoTalkError(send_typing_failed) on transport-level failure (non-zero statusCode)', async () => {
      mockSendTyping.mockResolvedValueOnce({ statusCode: -100, body: {} })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      try {
        await client.sendTyping('12345')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('send_typing_failed')
      }

      client.close()
    })

    it('throws KakaoTalkError(send_typing_failed) when the session throws (transport error)', async () => {
      mockSendTyping.mockRejectedValue(new Error('ACTION failed: statusCode=-1'))
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      try {
        await client.sendTyping('12345')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('send_typing_failed')
      }

      client.close()
    })

    it('throws KakaoTalkError(invalid_chat_id) for non-numeric chatId', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      try {
        await client.sendTyping('not-a-number')
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_chat_id')
      }

      client.close()
    })

    it('throws KakaoTalkError(invalid_link_id) for non-numeric linkId', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      try {
        await client.sendTyping('12345', { linkId: 'not-a-number' })
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_link_id')
      }

      client.close()
    })
  })

  describe('explicit member entry', () => {
    async function connected() {
      const client = await new KakaoTalkClient().login({ oauthToken: 'synthetic', userId: '1' })
      await client.getChats({ resolveTitles: false })
      return client
    }
    function member(id: number) {
      return { userId: makeLong(id), nickName: `Member ${id}` }
    }
    it('reads 112 members with one entry and two bounded MEMBER batches', async () => {
      const client = await connected()
      const rows = Array.from({ length: 112 }, (_, i) => member(i + 1))
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112, rows.slice(0, 5)))
      mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), mi: rows.map((m) => m.userId) } })
      mockGetMembersByIds.mockImplementation(async (_chat, ids) => ({
        statusCode: 0,
        body: {
          chatId: makeLong(100),
          members: rows.filter((m) => ids.some((id) => id.toString() === String(m.userId.low))),
        },
      }))
      const result = await client.enterRoomMemberSnapshot('100')
      expect(result.members).toHaveLength(112)
      expect(result.consistency_basis).toBe('entered_chatinfo_member')
      expect(mockEnterRoom).toHaveBeenCalledTimes(1)
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(2)
      expect(mockGetAllMembers).not.toHaveBeenCalled()
      expect(mockMarkRead).not.toHaveBeenCalled()
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    it('accepts the observed 112-record m response without issuing MEMBER requests', async () => {
      const client = await connected()
      const rows = Array.from({ length: 112 }, (_, i) => member(i + 1))
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112, rows.slice(0, 5)))
      mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: rows } })
      const result = await client.enterRoomMemberSnapshot('100')
      expect(result.members).toHaveLength(112)
      expect(result.members.filter((m) => m.user_id === '1')).toHaveLength(1)
      expect(result.complete).toBe(true)
      expect(mockGetChannelInfo).toHaveBeenCalledTimes(2)
      expect(mockEnterRoom).toHaveBeenCalledTimes(1)
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      expect(mockGetAllMembers).not.toHaveBeenCalled()
      expect(mockMarkRead).not.toHaveBeenCalled()
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    it('keeps count, identity and mixed-shape guards for large inline member responses', async () => {
      const client = await connected()
      const rows = Array.from({ length: 112 }, (_, i) => member(i + 1))
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112, rows.slice(0, 5)))
      for (const body of [
        { m: rows.slice(0, 111) },
        { m: [...rows, member(113)] },
        { m: [...rows.slice(0, 111), member(111)] },
        { m: [...rows.slice(1), member(113)] },
        { m: rows, mi: rows.map((m) => m.userId) },
      ]) {
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), ...body } })
        await expect(client.enterRoomMemberSnapshot('100')).rejects.toThrow()
      }
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      expect(mockEnterRoom).toHaveBeenCalledTimes(5)
      expect(mockMarkRead).not.toHaveBeenCalled()
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    it('includes the authenticated self omitted by the donor mi list without inventing members', async () => {
      const client = await connected()
      const rows = Array.from({ length: 112 }, (_, i) => member(i + 1))
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112, rows.slice(0, 5)))
      mockEnterRoom.mockResolvedValue({
        statusCode: 0,
        body: { c: makeLong(100), mi: rows.slice(1).map((m) => m.userId) },
      })
      mockGetMembersByIds.mockImplementation(async (_chat, ids) => ({
        statusCode: 0,
        body: {
          chatId: makeLong(100),
          members: rows.filter((m) => ids.some((id) => id.toString() === String(m.userId.low))),
        },
      }))
      const result = await client.enterRoomMemberSnapshot('100')
      expect(result.members).toHaveLength(112)
      expect(result.members.filter((m) => m.user_id === '1')).toHaveLength(1)
      expect(mockEnterRoom).toHaveBeenCalledTimes(1)
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(2)
      const requestedIds = mockGetMembersByIds.mock.calls.flatMap((call) => call[1].map((id: Long) => id.toString()))
      expect(requestedIds).toHaveLength(112)
      expect(new Set(requestedIds).size).toBe(112)
      expect(mockGetAllMembers).not.toHaveBeenCalled()
      expect(mockMarkRead).not.toHaveBeenCalled()
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    it('does not fill an unknown missing member or accept an extra member', async () => {
      const client = await connected()
      const ids = Array.from({ length: 112 }, (_, i) => makeLong(i + 1))
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112))
      for (const mi of [ids.slice(0, 111), ids.slice(2), [...ids, makeLong(113)], [...ids.slice(1), ids[1]]]) {
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), mi } })
        await expect(client.enterRoomMemberSnapshot('100')).rejects.toThrow()
      }
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      expect(mockEnterRoom).toHaveBeenCalledTimes(4)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    it('requires MEMBER to confirm the omitted self and rejects an unrelated substitute', async () => {
      const client = await connected()
      const rows = Array.from({ length: 112 }, (_, i) => member(i + 1))
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112))
      mockEnterRoom.mockResolvedValue({
        statusCode: 0,
        body: { c: makeLong(100), mi: rows.slice(1).map((m) => m.userId) },
      })
      mockGetMembersByIds.mockImplementation(async (_chat, ids) => ({
        statusCode: 0,
        body: {
          chatId: makeLong(100),
          members: rows
            .filter((m) => ids.some((id) => id.toString() === String(m.userId.low)))
            .map((m) => (m.userId.low === 1 ? member(113) : m)),
        },
      }))
      await expect(client.enterRoomMemberSnapshot('100')).rejects.toThrow()
      expect(mockEnterRoom).toHaveBeenCalledTimes(1)
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(2)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    it('distinguishes all entry-ID rejection inputs using counts and kinds only, without extra calls', async () => {
      const client = await connected()
      const ids = Array.from({ length: 112 }, (_, i) => makeLong(i + 1))
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112))
      const cases = [
        [{}, 'absent', null, 'absent', null, null, null],
        [{ mi: null }, 'null', null, 'absent', null, null, null],
        [{ mi: 'private-id-token' }, 'other', null, 'absent', null, null, null],
        [{ mi: ids, m: [{ userId: makeLong(1), nickName: 'private-name' }] }, 'array', 112, 'array', 1, null, null],
        [{ mi: ids, m: null }, 'array', 112, 'null', null, null, null],
        [{ mi: ids.slice(2) }, 'array', 110, 'absent', null, null, null],
        [{ mi: [...ids, makeLong(113)] }, 'array', 113, 'absent', null, null, null],
        [{ mi: ids.slice(0, 111) }, 'array', 111, 'absent', null, 111, true],
        [{ mi: [...ids.slice(1), makeLong(113)] }, 'array', 112, 'absent', null, 112, false],
      ] as const
      for (const [body, idsKind, idCount, recordsKind, recordCount, validatedIdCount, containsSelf] of cases) {
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), ...body } })
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100')
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(KakaoTalkError)
        const error = caught as KakaoTalkError
        expect(error.message).toBe('member_entry_ids_invalid')
        expect(error.memberEntryFailure).toEqual({
          activeCount: 112,
          idsKind,
          idCount,
          recordsKind,
          recordCount,
          validatedIdCount,
          containsSelf,
        })
        expect(Object.isFrozen(error.memberEntryFailure)).toBe(true)
        expect(JSON.stringify(error.memberEntryFailure)).not.toContain('private-')
      }
      expect(mockEnterRoom).toHaveBeenCalledTimes(cases.length)
      expect(mockGetChannelInfo).toHaveBeenCalledTimes(cases.length)
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      expect(mockGetAllMembers).not.toHaveBeenCalled()
      expect(mockMarkRead).not.toHaveBeenCalled()
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    it('names the CHATINFO display-member rule and ID shapes that refused the room, before any entry', async () => {
      const client = await connected()
      const overSafe = 2 ** 53 + 2 // a JS number past Number.MAX_SAFE_INTEGER has lost its exact value
      const base = { safeIds: 0, overSafeIds: 0, nonPositiveIds: 0, missingIds: 0, otherIds: 0, nonObjects: 0, duplicates: 0 }
      const cases: Array<[Array<unknown>, number, Record<string, unknown>]> = [
        [[member(1), { userId: overSafe, nickName: 'private-name' }, member(2)], 1117,
          { rule: 'id_invalid', recordCount: 3, safeIds: 2, overSafeIds: 1 }],
        [[member(1), { nickName: 'private-name' }], 1117, { rule: 'id_invalid', recordCount: 2, safeIds: 1, missingIds: 1 }],
        [[member(1), { userId: makeLong(0) }], 1117, { rule: 'id_invalid', recordCount: 2, safeIds: 1, nonPositiveIds: 1 }],
        [[member(1), { userId: 'private-id' }], 1117, { rule: 'id_invalid', recordCount: 2, safeIds: 1, otherIds: 1 }],
        [[member(1), member(1)], 1117, { rule: 'duplicate', recordCount: 2, safeIds: 2, duplicates: 1 }],
        [[member(1), null], 1117, { rule: 'not_object', recordCount: 2, safeIds: 1, nonObjects: 1 }],
        [[member(1), member(2), member(3)], 2, { rule: 'exceeds_active', recordCount: 3, safeIds: 3 }],
      ]
      for (const [display, active, expected] of cases) {
        mockGetChannelInfo.mockResolvedValue(memberChannelInfo(active, display as Array<Record<string, unknown>>))
        for (const read of [() => client.enterRoomMemberSnapshot('100'), () => client.getMemberSnapshot('100')]) {
          let caught: unknown
          try {
            await read()
          } catch (error) {
            caught = error
          }
          expect(caught).toBeInstanceOf(KakaoTalkError)
          const error = caught as KakaoTalkError
          expect(error.code).toBe('get_member_snapshot_failed')
          expect(error.message).toBe('CHATINFO member snapshot invalid')
          expect(error.memberRecordFailure).toEqual({ ...base, source: 'CHATINFO', activeCount: active, ...expected })
          expect(Object.isFrozen(error.memberRecordFailure)).toBe(true)
          expect(JSON.stringify(error.memberRecordFailure)).not.toContain('private-')
        }
      }
      // Refused at CHATINFO: no entry, member read or read mark happened.
      expect(mockEnterRoom).not.toHaveBeenCalled()
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      expect(mockGetAllMembers).not.toHaveBeenCalled()
      expect(mockMarkRead).not.toHaveBeenCalled()
      client.close()
    })
    it('reads an open room whose 1117 members all carry IDs above 2^53, keeping every ID exact', async () => {
      // Shape observed on the real 1117-member open room: CHATINFO shows the 1116
      // other members, every one above Number.MAX_SAFE_INTEGER.
      const base = 2n ** 53n
      const big = (i: number) => {
        const n = base + BigInt(i)
        return { low: Number(n & 0xffffffffn), high: Number(n >> 32n) }
      }
      const self = base + 1n
      const client = await new KakaoTalkClient().login({ oauthToken: 'synthetic', userId: self.toString() })
      await client.getChats({ resolveTitles: false })
      const rows = Array.from({ length: 1117 }, (_, i) => ({ userId: big(i + 1), nickName: `Open ${i + 1}` }))
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(1117, rows.slice(1)))
      mockGetAllMembers.mockResolvedValue({ statusCode: 0, body: { members: rows } })
      const snapshot = await client.getMemberSnapshot('100')
      expect(snapshot.members).toHaveLength(1117)
      expect(snapshot.members[0].user_id).toBe(self.toString())
      expect(snapshot.members[1].user_id).toBe((base + 2n).toString())
      expect(new Set(snapshot.members.map((m) => m.user_id)).size).toBe(1117)

      mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), mi: rows.map((m) => m.userId) } })
      mockGetMembersByIds.mockImplementation(async (_chat, ids) => ({
        statusCode: 0,
        body: { chatId: makeLong(100), members: rows.filter((m) => ids.some((id) => id.toString() === (base + BigInt(m.nickName.slice(5))).toString())) },
      }))
      const entered = await client.enterRoomMemberSnapshot('100')
      expect(entered.members).toHaveLength(1117)
      expect(new Set(entered.members.map((m) => m.user_id))).toEqual(new Set(rows.map((_, i) => (base + BigInt(i + 1)).toString())))
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(12)
      client.close()
    })
    describe('open-chat entry answered with records and the self record (olu)', () => {
      const base = 2n ** 53n
      const big = (i: number) => {
        const n = base + BigInt(i)
        return { low: Number(n & 0xffffffffn), high: Number(n >> 32n) }
      }
      const others = Array.from({ length: 1116 }, (_, i) => ({ userId: big(i + 2), nickName: `Open ${i + 2}` }))
      // The account as an m record (OpenMemberStruct) and as Kakao's olu
      // (OpenLinkChannelUserStruct: nickname `nn`, permission `lmt`).
      const self = { userId: big(1), nickName: 'Open self' }
      const olu = { userId: big(1), nn: 'Open self', ptp: 2, lmt: 2, pi: 'pi-self', fpi: 'fpi-self', opi: 'opi-self', opt: 7, pli: makeLong(55) }
      async function openClient() {
        const client = await new KakaoTalkClient().login({ oauthToken: 'synthetic', userId: (base + 1n).toString() })
        await client.getChats({ resolveTitles: false })
        mockGetChannelInfo.mockResolvedValue(memberChannelInfo(1117, others))
        return client
      }
      it('takes the 1116 listed members plus olu as the whole 1117 roster without MEMBER', async () => {
        const client = await openClient()
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: others, olu } })
        const snapshot = await client.enterRoomMemberSnapshot('100')
        expect(snapshot.complete).toBe(true)
        expect(snapshot.members).toHaveLength(1117)
        // The profile this account uses here comes from its own olu as answered:
        // its type stays 2 although the olu also carries a link.
        expect(snapshot.self_open_profile).toEqual({ profile_type: 2, link_id: '55' })
        // The olu row is read as the open member it is: its nn is the name.
        const own = snapshot.members.find((m) => m.user_id === (base + 1n).toString())
        expect(own).toMatchObject({ nickname: 'Open self', profile_image_url: 'pi-self', full_profile_image_url: 'fpi-self',
          original_profile_image_url: 'opi-self', open_token: 7, open_profile_link_id: '55', open_permission: 2 })
        expect(mockGetMembersByIds).not.toHaveBeenCalled()
        expect(mockEnterRoom).toHaveBeenCalledTimes(1)
        client.close()
      })
      it('still refuses a capped list and names its counts, shape and olu use', async () => {
        const client = await openClient()
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: others.slice(0, 1000), olu } })
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100')
        } catch (error) {
          caught = error
        }
        const error = caught as KakaoTalkError
        expect(error.message).toBe('member_entry_changed_or_incomplete')
        expect(error.memberEntryConsistency).toEqual({
          entryShape: 'records', firstActive: 1117, secondActive: 1117, recordCount: 1001,
          firstDisplayCount: 1116, secondDisplayCount: 1116, displayIdsStable: true, displayContainedCount: 1000,
          openSelfRecord: 'added', accountInRecords: true,
        })
        expect(Object.isFrozen(error.memberEntryConsistency)).toBe(true)
        expect(JSON.stringify(error.memberEntryConsistency)).not.toContain('Open')
        client.close()
      })
      it('never adds an olu that is not this account, so a missing member is never covered by it', async () => {
        // Reviewer case: the account and A listed, B missing, olu carrying another (open) ID.
        const client = await new KakaoTalkClient().login({ oauthToken: 'synthetic', userId: '1' })
        await client.getChats({ resolveTitles: false })
        const member = (id: number) => ({ userId: makeLong(id), nickName: `M ${id}` })
        mockGetChannelInfo.mockResolvedValue(memberChannelInfo(3, [member(2)]))
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: [member(1), member(2)], olu: member(9) } })
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100')
        } catch (error) {
          caught = error
        }
        const error = caught as KakaoTalkError
        expect(error.message).toBe('member_entry_changed_or_incomplete')
        expect(error.memberEntryConsistency).toMatchObject({ recordCount: 2, openSelfRecord: 'foreign', accountInRecords: true })
        // A foreign olu already listed in m is reported as foreign, not as this account's record.
        mockGetChannelInfo.mockResolvedValue(memberChannelInfo(3, [member(2)]))
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: [member(2), member(9)], olu: member(9) } })
        caught = undefined
        try {
          await client.enterRoomMemberSnapshot('100')
        } catch (failure) {
          caught = failure
        }
        expect((caught as KakaoTalkError).memberEntryConsistency).toMatchObject({ recordCount: 2, openSelfRecord: 'foreign', accountInRecords: false })
        // And without the account in m, a foreign olu does not stand in for it either.
        mockGetChannelInfo.mockResolvedValue(memberChannelInfo(3, [member(2)]))
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: [member(2), member(3)], olu: member(9) } })
        caught = undefined
        try {
          await client.enterRoomMemberSnapshot('100')
        } catch (failure) {
          caught = failure
        }
        expect((caught as KakaoTalkError).memberEntryConsistency).toMatchObject({ recordCount: 2, openSelfRecord: 'foreign', accountInRecords: false })
        client.close()
      })
      it('keeps the CHATINFO name of the account when its olu carries no string name', async () => {
        // Reviewer case: olu without nn (or with a non-string nn) must not blank the account's listed name.
        for (const nameless of [{ userId: makeLong(1), lmt: 2 }, { userId: makeLong(1), nn: 7, lmt: 2 }]) {
          const client = await new KakaoTalkClient().login({ oauthToken: 'synthetic', userId: '1' })
          await client.getChats({ resolveTitles: false })
          mockGetChannelInfo.mockResolvedValue(memberChannelInfo(2, [{ userId: makeLong(1), nickName: '내 이름' }]))
          mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: [{ userId: makeLong(2), nickName: '상대' }], olu: nameless } })
          const snapshot = await client.enterRoomMemberSnapshot('100')
          expect(snapshot.members).toHaveLength(2)
          expect(snapshot.members.find((m) => m.user_id === '1')).toMatchObject({ nickname: '내 이름', open_permission: 2 })
          client.close()
        }
      })
      it('does not add olu twice and reports it as already present', async () => {
        const client = await openClient()
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: [self, ...others.slice(0, 1000)], olu } })
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100')
        } catch (error) {
          caught = error
        }
        const error = caught as KakaoTalkError
        expect(error.memberEntryConsistency).toMatchObject({ recordCount: 1001, openSelfRecord: 'present', accountInRecords: true })
        client.close()
      })
    })
    it('names a GETMEM record refusal and keeps it on getMembers', async () => {
      const client = await connected()
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(2, [member(1)]))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: { members: [member(1), { userId: 2 ** 53 + 2, nickName: 'private-name' }] },
      })
      let caught: unknown
      try {
        await client.getMembers('100')
      } catch (error) {
        caught = error
      }
      const error = caught as KakaoTalkError
      expect(error.code).toBe('get_members_failed')
      expect(error.message).toBe('GETMEM member snapshot invalid')
      expect(error.memberRecordFailure).toEqual({
        source: 'GETMEM', rule: 'id_invalid', recordCount: 2, activeCount: null,
        safeIds: 1, overSafeIds: 1, nonPositiveIds: 0, missingIds: 0, otherIds: 0, nonObjects: 0, duplicates: 0,
      })
      client.close()
    })
    it('rejects partial MEMBER batches without retry or login', async () => {
      const client = await connected()
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112))
      mockEnterRoom.mockResolvedValue({
        statusCode: 0,
        body: { c: makeLong(100), mi: Array.from({ length: 112 }, (_, i) => makeLong(i + 1)) },
      })
      mockGetMembersByIds.mockResolvedValue({ statusCode: 0, body: { members: [member(1)] } })
      await expect(client.enterRoomMemberSnapshot('100')).rejects.toThrow()
      expect(mockEnterRoom).toHaveBeenCalledTimes(1)
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    it('uses m for small rooms and rejects an incorrect room', async () => {
      const client = await connected()
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(2, [member(1)]))
      mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), m: [member(1), member(2)] } })
      expect((await client.enterRoomMemberSnapshot('100')).members).toHaveLength(2)
      mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(200), m: [member(1), member(2)] } })
      await expect(client.enterRoomMemberSnapshot('100')).rejects.toThrow()
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      client.close()
    })
    it('rejects abort before dispatch and late results after close', async () => {
      const client = await connected()
      await expect(client.enterRoomMemberSnapshot('100', { signal: AbortSignal.abort() })).rejects.toThrow()
      expect(mockGetChannelInfo).not.toHaveBeenCalled()
      let resolve!: (value: unknown) => void
      mockGetChannelInfo.mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
      const pending = client.enterRoomMemberSnapshot('100')
      client.close()
      resolve(memberChannelInfo(2))
      await expect(pending).rejects.toThrow()
      expect(mockEnterRoom).not.toHaveBeenCalled()
      expect(mockLogin).toHaveBeenCalledTimes(1)
    })

    describe('continuing a stopped entry', () => {
      const rows = Array.from({ length: 1117 }, (_, i) => member(i + 1))
      const display = rows.slice(0, 5)
      function requested(call: number): string[] {
        return mockGetMembersByIds.mock.calls[call][1].map((id: Long) => id.toString())
      }
      function answerBatches(failAt: number | null) {
        let calls = 0
        mockGetMembersByIds.mockImplementation(async (_chat, ids) => {
          calls += 1
          if (calls === failAt) return { statusCode: -999, body: {} }
          return {
            statusCode: 0,
            body: {
              chatId: makeLong(100),
              members: rows.filter((m) => ids.some((id: Long) => id.toString() === String(m.userId.low))),
            },
          }
        })
      }
      async function stopped(client: KakaoTalkClient, failAt = 8) {
        mockGetChannelInfo.mockResolvedValue(memberChannelInfo(1117, display))
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), mi: rows.map((m) => m.userId) } })
        answerBatches(failAt)
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100')
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(KakaoTalkError)
        return caught as KakaoTalkError
      }

      it('keeps the 700 rows read before the eighth batch failed and asks only for the other 417', async () => {
        const client = await connected()
        const failure = await stopped(client)
        expect(failure.message).toBe('MEMBER failed: statusCode=-999')
        expect(failure.memberEntryProgress).toEqual({ chat_id: '100', active_members: 1117, received: 700 })
        expect(Object.isFrozen(failure.memberEntryProgress)).toBe(true)
        expect(JSON.stringify(failure.memberEntryProgress)).not.toContain('Member')
        expect(mockEnterRoom).toHaveBeenCalledTimes(1)
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(8)
        const firstSeven = Array.from({ length: 7 }, (_, i) => requested(i)).flat()

        answerBatches(null)
        const result = await client.enterRoomMemberSnapshot('100', { progress: failure.memberEntryProgress })
        expect(result.complete).toBe(true)
        expect(result.consistency_basis).toBe('entered_chatinfo_member')
        expect(result.members).toHaveLength(1117)
        expect(new Set(result.members.map((m) => m.user_id)).size).toBe(1117)
        // No second CHATONROOM; 417 IDs in five batches, none of the first 700.
        expect(mockEnterRoom).toHaveBeenCalledTimes(1)
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(13)
        const continued = Array.from({ length: 5 }, (_, i) => requested(8 + i))
        expect(continued.map((batch) => batch.length)).toEqual([100, 100, 100, 100, 17])
        expect(continued.flat().filter((id) => firstSeven.includes(id))).toHaveLength(0)
        expect(new Set([...firstSeven, ...continued.flat()]).size).toBe(1117)
        expect(mockGetChannelInfo).toHaveBeenCalledTimes(3)
        expect(mockGetAllMembers).not.toHaveBeenCalled()
        expect(mockMarkRead).not.toHaveBeenCalled()
        expect(mockLogin).toHaveBeenCalledTimes(1)
        client.close()
      })

      it('shows the received members of a progress without using it up', async () => {
        const client = await connected()
        const failure = await stopped(client)
        const shown = client.memberEntryProgressMembers(failure.memberEntryProgress!)
        expect(shown).toHaveLength(700)
        expect(shown.slice(0, 2).map((m) => [m.user_id, m.nickname])).toEqual([['1', 'Member 1'], ['2', 'Member 2']])
        expect(client.memberEntryProgressMembers({ chat_id: '100', active_members: 1117, received: 700 })).toEqual([])
        answerBatches(null)
        expect((await client.enterRoomMemberSnapshot('100', { progress: failure.memberEntryProgress })).members).toHaveLength(1117)
        expect(client.memberEntryProgressMembers(failure.memberEntryProgress!)).toEqual([])
        client.close()
      })

      it('continues a progress at most once and only for its own room', async () => {
        const client = await connected()
        const failure = await stopped(client)
        const progress = failure.memberEntryProgress!
        await expect(client.enterRoomMemberSnapshot('200', { progress })).rejects.toThrow('member_entry_progress_invalid')
        // Refused for the other room, the progress is gone for this one too.
        await expect(client.enterRoomMemberSnapshot('100', { progress })).rejects.toThrow('member_entry_progress_invalid')
        await expect(
          client.enterRoomMemberSnapshot('100', { progress: { chat_id: '100', active_members: 1117, received: 700 } }),
        ).rejects.toThrow('member_entry_progress_invalid')
        expect(mockGetChannelInfo).toHaveBeenCalledTimes(1)
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(8)
        expect(mockEnterRoom).toHaveBeenCalledTimes(1)
        client.close()
      })

      it('drops the progress when the count or the displayed members changed, before any MEMBER', async () => {
        for (const changed of [memberChannelInfo(1118, display), memberChannelInfo(1117, rows.slice(1, 6))]) {
          mockGetChannelInfo.mockReset()
          mockGetMembersByIds.mockReset()
          mockEnterRoom.mockReset()
          const client = await connected()
          const failure = await stopped(client)
          mockGetChannelInfo.mockResolvedValue(changed)
          answerBatches(null)
          let caught: unknown
          try {
            await client.enterRoomMemberSnapshot('100', { progress: failure.memberEntryProgress })
          } catch (error) {
            caught = error
          }
          expect((caught as KakaoTalkError).message).toBe('member_entry_progress_stale')
          expect((caught as KakaoTalkError).memberEntryProgress).toBeUndefined()
          expect(mockGetMembersByIds).toHaveBeenCalledTimes(8)
          expect(mockEnterRoom).toHaveBeenCalledTimes(1)
          client.close()
        }
      })

      it('keeps the rows of a continuation that failed again and hands out a new progress', async () => {
        const client = await connected()
        const failure = await stopped(client)
        answerBatches(2)
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100', { progress: failure.memberEntryProgress })
        } catch (error) {
          caught = error
        }
        const again = caught as KakaoTalkError
        expect(again.memberEntryProgress).toEqual({ chat_id: '100', active_members: 1117, received: 800 })
        answerBatches(null)
        expect((await client.enterRoomMemberSnapshot('100', { progress: again.memberEntryProgress })).members).toHaveLength(1117)
        expect(mockEnterRoom).toHaveBeenCalledTimes(1)
        // 317 left after 800 rows: 100, 100, 100 and 17.
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(8 + 2 + 4)
        client.close()
      })

      it('keeps the progress when the continuation stops at its first CHATINFO', async () => {
        const client = await connected()
        const failure = await stopped(client)
        mockGetChannelInfo.mockResolvedValueOnce({ statusCode: -500, body: {} })
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100', { progress: failure.memberEntryProgress })
        } catch (error) {
          caught = error
        }
        const again = caught as KakaoTalkError
        expect(again.memberEntryProgress).toEqual({ chat_id: '100', active_members: 1117, received: 700 })
        answerBatches(null)
        expect((await client.enterRoomMemberSnapshot('100', { progress: again.memberEntryProgress })).members).toHaveLength(1117)
        expect(mockEnterRoom).toHaveBeenCalledTimes(1)
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(8 + 5)
        client.close()
      })

      it('hands out no progress when the room changed after every row arrived', async () => {
        const client = await connected()
        let reads = 0
        mockGetChannelInfo.mockImplementation(async () => memberChannelInfo(++reads === 1 ? 1117 : 1116, display))
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), mi: rows.map((m) => m.userId) } })
        answerBatches(null)
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100')
        } catch (error) {
          caught = error
        }
        expect((caught as KakaoTalkError).message).toBe('member_entry_changed_or_incomplete')
        expect((caught as KakaoTalkError).memberEntryProgress).toBeUndefined()
        client.close()
      })

      it('keeps the progress of an aborted entry but not of a closed session', async () => {
        const client = await connected()
        mockGetChannelInfo.mockResolvedValue(memberChannelInfo(1117, display))
        mockEnterRoom.mockResolvedValue({ statusCode: 0, body: { c: makeLong(100), mi: rows.map((m) => m.userId) } })
        const controller = new AbortController()
        let calls = 0
        mockGetMembersByIds.mockImplementation(async (_chat, ids) => {
          if (++calls === 3) controller.abort()
          return {
            statusCode: 0,
            body: { chatId: makeLong(100), members: rows.filter((m) => ids.some((id: Long) => id.toString() === String(m.userId.low))) },
          }
        })
        let caught: unknown
        try {
          await client.enterRoomMemberSnapshot('100', { signal: controller.signal })
        } catch (error) {
          caught = error
        }
        // The third answer came after the abort: it is not counted.
        expect((caught as KakaoTalkError).memberEntryProgress).toEqual({ chat_id: '100', active_members: 1117, received: 200 })
        const progress = (caught as KakaoTalkError).memberEntryProgress
        client.close()
        await expect(client.enterRoomMemberSnapshot('100', { progress })).rejects.toThrow()
        expect(mockEnterRoom).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('getSelectedMembersOnce', () => {
    const chatId = '9007199254740993'
    const peer = '9007199254740994'
    const self = '9223372036854775807'
    const row = (id: string) => ({ userId: Long.fromString(id), nickName: `member-${id}`, ptp: 16,
      pli: Long.fromString('9007199254740995'), profileImageUrl: 'https://example.test/photo' })
    const answer = (ids = [peer]) => ({ statusCode: 0, body: { chatId: Long.fromString(chatId), members: ids.map(row) } })
    async function ready() {
      const client = await new KakaoTalkClient().login({ oauthToken: 'synthetic', userId: '1' })
      await client.getChats({ resolveTitles: false })
      return client
    }
    async function rejectedResponse(response: unknown) {
      const client = await ready()
      mockGetMembersByIds.mockResolvedValueOnce(response)
      await expect(client.getSelectedMembersOnce(chatId, [peer])).rejects.toMatchObject({ code: 'get_selected_members_failed' })
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      expect(mockGetAllMembers).not.toHaveBeenCalled()
      expect(mockEnterRoom).not.toHaveBeenCalled()
      client.close()
    }

    for (const ids of [[peer], [self, peer]]) {
      it(`returns exact ${ids.length} rows and preserves adjacent large IDs and profile fields`, async () => {
        const client = await ready()
        mockGetMembersByIds.mockResolvedValueOnce(answer([...ids].reverse()))
        const members = await client.getSelectedMembersOnce(chatId, ids)
        expect(members.map((m) => m.user_id)).toEqual([...ids].reverse())
        expect(members[0]).toMatchObject({ open_profile_type: 16, open_profile_link_id: '9007199254740995',
          profile_image_url: 'https://example.test/photo' })
        const call = mockGetMembersByIds.mock.calls[0] as unknown as [Long, Long[]]
        expect(call[0].toString()).toBe(chatId)
        expect(call[1].map((id) => id.toString())).toEqual(ids)
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
        expect(mockGetAllMembers).not.toHaveBeenCalled()
        expect(mockGetChannelInfo).not.toHaveBeenCalled()
        expect(mockEnterRoom).not.toHaveBeenCalled()
        expect(mockLogin).toHaveBeenCalledTimes(1)
        client.close()
      })
    }
    for (const pli of [Number('9007199254740993'), { low: 0x100000001, high: 0 },
      { low: 1, high: 0x100000000 }, { low: 1.5, high: 0 }, Long.fromString('9223372036854775808'),
      '18446744073709551617', '01', -1, true, {}]) {
      it(`rejects invalid selected raw profile link ${JSON.stringify(pli)} before conversion`, async () => {
        const client = await ready()
        mockGetMembersByIds.mockResolvedValueOnce({ ...answer(), body: { ...answer().body,
          members: [{ ...row(peer), pli }] } })
        await expect(client.getSelectedMembersOnce(chatId, [peer])).rejects.toThrow('selected_member_link_invalid')
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
        client.close()
      })
    }
    for (const pli of [undefined, null, 0, '0', Long.ZERO]) {
      it(`keeps absent/zero selected raw profile link ${JSON.stringify(pli)} unobserved`, async () => {
        const client = await ready()
        mockGetMembersByIds.mockResolvedValueOnce({ ...answer(), body: { ...answer().body,
          members: [{ ...row(peer), pli }] } })
        expect((await client.getSelectedMembersOnce(chatId, [peer]))[0].open_profile_link_id).toBeNull()
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
        client.close()
      })
    }
    for (const pli of [Long.fromString('9007199254740993'), '9007199254740993', Long.MAX_VALUE, 42]) {
      it(`normalizes valid selected raw profile link ${JSON.stringify(pli)} without loss`, async () => {
        const client = await ready()
        const raw = { ...row(peer), pli }
        mockGetMembersByIds.mockResolvedValueOnce({ ...answer(), body: { ...answer().body, members: [raw] } })
        expect((await client.getSelectedMembersOnce(chatId, [peer]))[0].open_profile_link_id).toBe(String(pli))
        expect(raw.pli).toBe(pli)
        client.close()
      })
    }
    for (const ids of [new Array<string>(1), new Array<string>(2),
      Object.assign(new Array<string>(2), { 0: peer }), Object.assign(new Array<string>(2), { 1: peer })]) {
      it(`rejects sparse selected input ${JSON.stringify(ids)} without dispatch on a prepared session`, async () => {
        const client = await ready()
        await expect(client.getSelectedMembersOnce(chatId, ids)).rejects.toMatchObject({ code: 'invalid_user_id' })
        expect(mockGetMembersByIds).not.toHaveBeenCalled()
        expect(mockLogin).toHaveBeenCalledTimes(1)
        client.close()
      })
    }
    for (const invalid of ['', '0', '-1', '+1', '01', ' 1', '1.0', '1e2', '9223372036854775808',
      '18446744073709551617', null, undefined, 9007199254740992, {}, true]) {
      it(`rejects noncanonical chat/user input ${JSON.stringify(invalid)} before any connection`, async () => {
        const client = new KakaoTalkClient()
        await expect(client.getSelectedMembersOnce(invalid as string, [peer])).rejects.toMatchObject({ code: 'invalid_chat_id' })
        await expect(client.getSelectedMembersOnce(chatId, [invalid as string])).rejects.toMatchObject({ code: 'invalid_user_id' })
        expect(mockLogin).not.toHaveBeenCalled()
        expect(mockGetMembersByIds).not.toHaveBeenCalled()
        client.close()
      })
    }
    for (const invalid of [[], [peer, peer], [peer, self, '1'], null, undefined, '1', {}]) {
      it(`rejects selection count/duplicates ${JSON.stringify(invalid)} without acquisition`, async () => {
        const client = new KakaoTalkClient()
        await expect(client.getSelectedMembersOnce(chatId, invalid as string[])).rejects.toMatchObject({ code: 'get_selected_members_failed' })
        expect(mockLogin).not.toHaveBeenCalled()
        expect(mockGetMembersByIds).not.toHaveBeenCalled()
        client.close()
      })
    }
    it('refuses a lazy authenticated client until the session is prepared', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'synthetic', userId: '1' })
      await expect(client.getSelectedMembersOnce(chatId, [peer])).rejects.toThrow('selected_member_session_changed')
      expect(mockLogin).not.toHaveBeenCalled()
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      client.close()
    })
    for (const failure of ['connection_admission_denied', 'connection_admission_failed']) {
      it(`refuses ${failure} even while a prepared session remains`, async () => {
        const client = await ready()
        const internals = client as unknown as { admissionFailure: string | null; state: unknown }
        expect(internals.state).not.toBeNull()
        internals.admissionFailure = failure
        await expect(client.getSelectedMembersOnce(chatId, [peer])).rejects.toThrow('selected_member_session_changed')
        expect(mockGetMembersByIds).not.toHaveBeenCalled()
        expect(mockLogin).toHaveBeenCalledTimes(1)
        client.close()
      })
    }
    it('rejects late success if admission is blocked with the same prepared state', async () => {
      const client = await ready()
      const internals = client as unknown as { admissionFailure: string | null; state: unknown }
      const state = internals.state
      let resolve!: (value: unknown) => void
      mockGetMembersByIds.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
      const pending = client.getSelectedMembersOnce(chatId, [peer])
      internals.admissionFailure = 'connection_admission_denied'
      expect(internals.state).toBe(state)
      resolve(answer())
      await expect(pending).rejects.toThrow('selected_member_session_changed')
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })
    for (const invalid of [undefined, null, 0, Number(chatId), '9007199254740992', '18446744073709551617',
      Long.fromString('9007199254740992'), { low: 1, high: 0.5 }, { low: 0x100000000, high: 0 }]) {
      it(`rejects missing/wrong/unsafe response chat ${JSON.stringify(invalid)}`, async () => {
        await rejectedResponse({ ...answer(), body: { ...answer().body, chatId: invalid } })
      })
    }
    for (const invalid of [undefined, null, {}, [], [row(self)], [row(peer), row(peer)], [row(peer), row(self)],
      [{ userId: Number(peer) }], [{ userId: '9007199254740994' }], [null], [{}],
      [{ userId: Long.fromString('9223372036854775808') }], [{ userId: { low: 1, high: 0.5 } }]]) {
      it(`rejects missing/duplicate/extra/malformed member rows ${JSON.stringify(invalid)}`, async () => {
        await rejectedResponse({ ...answer(), body: { ...answer().body, members: invalid } })
      })
    }
    it('rejects a two-person response missing self', async () => {
      const client = await ready()
      mockGetMembersByIds.mockResolvedValueOnce(answer())
      await expect(client.getSelectedMembersOnce(chatId, [self, peer])).rejects.toThrow('selected_member_ids_mismatch')
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
      client.close()
    })
    for (const status of [-310, -1, undefined, null, '0', NaN]) {
      it(`rejects invalid/nonzero packet status ${String(status)} without retry`, async () => {
        await rejectedResponse({ ...answer(), statusCode: status })
      })
    }
    for (const status of [null, '0', 'failure', false, {}, NaN]) {
      it(`rejects malformed body status ${JSON.stringify(status)}`, async () => {
        await rejectedResponse({ ...answer(), body: { ...answer().body, status } })
      })
    }
    it('accepts signed-int64 maximum chat and adjacent member IDs without wrapping', async () => {
      const client = await ready()
      mockGetMembersByIds.mockResolvedValueOnce({ statusCode: 0,
        body: { chatId: Long.fromString(self), status: 0, members: [row(peer), row(chatId)] } })
      const members = await client.getSelectedMembersOnce(self, [peer, chatId])
      expect(members.map((member) => member.user_id)).toEqual([peer, chatId])
      const call = mockGetMembersByIds.mock.calls[0] as unknown as [Long, Long[]]
      expect(call[0].toString()).toBe(self)
      expect(call[1].map((id) => id.toString())).toEqual([peer, chatId])
      client.close()
    })
    it('preserves provider rejection classification and body status', async () => {
      const client = await ready()
      mockGetMembersByIds.mockResolvedValueOnce({ ...answer(), body: { ...answer().body, status: -42 } })
      await expect(client.getSelectedMembersOnce(chatId, [peer])).rejects.toMatchObject({
        code: 'get_selected_members_failed', serverStatus: -42, responseStatusSource: 'body', responseFailureKind: 'provider_rejection',
      })
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
      client.close()
    })
    for (const change of ['invalidate', 'replace', 'close'] as const) {
      it(`rejects late success after ${change} and never replays`, async () => {
        const client = await ready()
        let resolve!: (value: unknown) => void
        mockGetMembersByIds.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
        const pending = client.getSelectedMembersOnce(chatId, [peer])
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
        if (change === 'close') client.close()
        else {
          mockOnClose.mock.calls.at(-1)?.[0]()
          if (change === 'replace') await client.getChats({ resolveTitles: false })
        }
        resolve(answer())
        await expect(pending).rejects.toThrow('selected_member_session_changed')
        expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
        expect(mockLogin).toHaveBeenCalledTimes(change === 'replace' ? 2 : 1)
        client.close()
      })
    }
    it('propagates transport failure without reconnect or retry', async () => {
      const client = await ready()
      mockGetMembersByIds.mockImplementationOnce(async () => {
        mockOnClose.mock.calls.at(-1)?.[0]()
        throw new Error('synthetic transport failure')
      })
      await expect(client.getSelectedMembersOnce(chatId, [peer])).rejects.toMatchObject({
        code: 'get_selected_members_failed', responseFailureKind: 'transient_or_unknown',
      })
      expect(mockLogin).toHaveBeenCalledTimes(1)
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)
      client.close()
    })
  })

  describe('getMembers / getMembersByIds', () => {
    it('returns formatted members from GETMEM with normalized fields', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(2)).mockResolvedValueOnce(memberChannelInfo(2))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: {
          members: [
            {
              userId: makeLong(42),
              nickName: 'Alice',
              type: 100,
              profileImageUrl: 'https://kakao.com/p/alice.jpg',
              fullProfileImageUrl: 'https://kakao.com/p/alice-full.jpg',
              originalProfileImageUrl: 'https://kakao.com/p/alice-orig.jpg',
              statusMessage: 'hi',
              countryIso: 'KR',
            },
            {
              userId: makeLong(43),
              nickName: 'Bob',
              type: 1000,
              pi: 'https://kakao.com/p/bob.jpg',
              fpi: 'https://kakao.com/p/bob-full.jpg',
              opi: 'https://kakao.com/p/bob-orig.jpg',
              opt: 12345,
              pli: makeLong(99),
              mt: 4,
            },
          ],
          token: 0,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const members = await client.getMembers('100')

      expect(members).toHaveLength(2)
      expect(members[0]).toEqual({
        user_id: '42',
        nickname: 'Alice',
        profile_image_url: 'https://kakao.com/p/alice.jpg',
        full_profile_image_url: 'https://kakao.com/p/alice-full.jpg',
        original_profile_image_url: 'https://kakao.com/p/alice-orig.jpg',
        status_message: 'hi',
        country_iso: 'KR',
        user_type: 100,
        open_token: null,
        open_profile_link_id: null,
        open_permission: null,
      })
      expect(members[1]).toEqual({
        user_id: '43',
        nickname: 'Bob',
        profile_image_url: 'https://kakao.com/p/bob.jpg',
        full_profile_image_url: 'https://kakao.com/p/bob-full.jpg',
        original_profile_image_url: 'https://kakao.com/p/bob-orig.jpg',
        status_message: null,
        country_iso: null,
        user_type: 1000,
        open_token: 12345,
        open_profile_link_id: '99',
        open_permission: 4,
      })
      expect(mockGetChatInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('rejects a partial GETMEM snapshot without entering the room', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(3)).mockResolvedValueOnce(memberChannelInfo(3))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: {
          members: [
            {
              userId: makeLong(42),
              nickName: 'Alice',
              type: 100,
              profileImageUrl: 'https://kakao.com/p/alice.jpg',
            },
          ],
          token: 0,
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await expect(client.getMembers('100')).rejects.toMatchObject({
        code: 'get_members_failed',
      })
      expect(mockGetChatInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('reports only counts and comparisons when GETMEM is incomplete', async () => {
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(112))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: { members: [{ userId: makeLong(42), nickName: 'Private member name' }] },
      })
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMemberSnapshot('100')
        throw new Error('incomplete snapshot must fail')
      } catch (error) {
        expect(error).toBeInstanceOf(KakaoTalkError)
        const failure = error as KakaoTalkError
        expect(failure.code).toBe('get_member_snapshot_failed')
        expect(failure.message).toBe('member_snapshot_changed_or_incomplete')
        expect(failure.memberSnapshotFailure).toEqual({
          firstActiveCount: 112,
          firstMemberCount: 1,
          secondActiveCount: 112,
          secondMemberCount: 1,
          displayIdsStable: true,
          memberIdsStable: true,
          displayMembersContained: true,
        })
        expect(Object.isFrozen(failure.memberSnapshotFailure)).toBe(true)
        expect(JSON.stringify(failure.memberSnapshotFailure)).not.toContain('Private member name')
        expect(JSON.stringify(failure.memberSnapshotFailure)).not.toContain('userId')
      }
      expect(mockGetChannelInfo).toHaveBeenCalledTimes(2)
      expect(mockGetAllMembers).toHaveBeenCalledTimes(2)
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      expect(mockMarkRead).not.toHaveBeenCalled()
      client.close()
    })

    it('returns a stable empty snapshot for a zero-member room without CHATONROOM', async () => {
      mockGetChannelInfo.mockResolvedValue(memberChannelInfo(0))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: { members: [] },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const snapshot = await client.getMemberSnapshot('100')

      expect(snapshot).toMatchObject({
        chat_id: '100',
        active_members: 0,
        complete: true,
        consistency_basis: 'stable_double_read_chatinfo_getmem',
      })
      expect(snapshot.members).toEqual([])
      expect(mockGetAllMembers).toHaveBeenCalledTimes(2)
      expect(mockGetChatInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('returns a stable CHATINFO GETMEM snapshot without CHATONROOM', async () => {
      const visible = [
        {
          userId: makeLong(42),
          nickName: 'Alice',
          type: 100,
        },
      ]
      mockGetChannelInfo
        .mockResolvedValueOnce(memberChannelInfo(2, visible))
        .mockResolvedValueOnce(memberChannelInfo(2, visible))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: {
          members: [
            visible[0],
            {
              userId: makeLong(43),
              nickName: 'Bob',
              type: 100,
            },
          ],
        },
      })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      const snapshot = await client.getMemberSnapshot('100')

      expect(snapshot).toMatchObject({
        chat_id: '100',
        active_members: 2,
        complete: true,
        consistency_basis: 'stable_double_read_chatinfo_getmem',
      })
      expect(snapshot.members.map((member) => member.user_id)).toEqual(['42', '43'])
      expect(mockGetAllMembers).toHaveBeenCalledTimes(2)
      expect(mockGetChannelInfo).toHaveBeenCalledTimes(2)
      expect(mockGetChatInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('fails closed when active membership changes across the snapshot', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(2)).mockResolvedValueOnce(memberChannelInfo(3))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: {
          members: [
            { userId: makeLong(42), nickName: 'Alice' },
            { userId: makeLong(43), nickName: 'Bob' },
          ],
        },
      })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      await expect(client.getMemberSnapshot('100')).rejects.toMatchObject({
        code: 'get_member_snapshot_failed',
        memberSnapshotFailure: {
          firstActiveCount: 2,
          firstMemberCount: 2,
          secondActiveCount: 3,
          secondMemberCount: 2,
          displayIdsStable: true,
          memberIdsStable: true,
          displayMembersContained: true,
        },
      })
      expect(mockGetChatInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('fails closed on a same-cardinality hidden member swap', async () => {
      const visible = [{ userId: makeLong(42), nickName: 'Visible' }]
      mockGetChannelInfo
        .mockResolvedValueOnce(memberChannelInfo(2, visible))
        .mockResolvedValueOnce(memberChannelInfo(2, visible))
      mockGetAllMembers
        .mockResolvedValueOnce({
          statusCode: 0,
          body: {
            members: [visible[0], { userId: makeLong(43), nickName: 'Departed' }],
          },
        })
        .mockResolvedValueOnce({
          statusCode: 0,
          body: {
            members: [visible[0], { userId: makeLong(44), nickName: 'Joined' }],
          },
        })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      await expect(client.getMemberSnapshot('100')).rejects.toMatchObject({
        code: 'get_member_snapshot_failed',
        memberSnapshotFailure: {
          firstActiveCount: 2,
          firstMemberCount: 2,
          secondActiveCount: 2,
          secondMemberCount: 2,
          displayIdsStable: true,
          memberIdsStable: false,
          displayMembersContained: true,
        },
      })

      client.close()
    })

    it('fails closed on malformed CHATINFO member identity', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(1, [{ userId: {}, nickName: 'Malformed' }]))

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      await expect(client.getMemberSnapshot('100')).rejects.toMatchObject({
        code: 'get_member_snapshot_failed',
      })
      expect(mockGetAllMembers).not.toHaveBeenCalled()

      client.close()
    })

    it('fails closed on malformed GETMEM member identity', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(1))
      mockGetAllMembers.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          members: [{ userId: '42', nickName: 'Malformed string id' }],
        },
      })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      await expect(client.getMemberSnapshot('100')).rejects.toMatchObject({
        code: 'get_member_snapshot_failed',
      })

      client.close()
    })

    it('fails closed on duplicate GETMEM identity without CHATONROOM', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(2))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: {
          members: [
            { userId: makeLong(42), nickName: 'Alice' },
            { userId: makeLong(42), nickName: 'Duplicate' },
          ],
        },
      })

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      await expect(client.getMemberSnapshot('100')).rejects.toMatchObject({
        code: 'get_member_snapshot_failed',
      })
      expect(mockGetChatInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('fails closed on CHATINFO chat id mismatch before GETMEM', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(1, [], 101))

      const client = await new KakaoTalkClient().login({
        oauthToken: 'token',
        userId: 'user1',
        deviceUuid: 'device1',
      })
      await expect(client.getMemberSnapshot('100')).rejects.toMatchObject({
        code: 'get_member_snapshot_failed',
      })
      expect(mockGetAllMembers).not.toHaveBeenCalled()
      expect(mockGetChatInfo).not.toHaveBeenCalled()

      client.close()
    })

    it('normalizes missing user_type to null and treats pli=0 as absent', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(3)).mockResolvedValueOnce(memberChannelInfo(3))
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: {
          members: [
            { userId: makeLong(1), nickName: 'NoType' },
            { userId: makeLong(2), nickName: 'ZeroPli', type: 1000, pli: makeLong(0) },
            { userId: makeLong(3), nickName: 'NumericZeroPli', type: 1000, pli: 0 },
          ],
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const members = await client.getMembers('100')

      expect(members[0].user_type).toBeNull()
      expect(members[0].open_profile_link_id).toBeNull()
      expect(members[1].user_type).toBe(1000)
      expect(members[1].open_profile_link_id).toBeNull()
      expect(members[2].open_profile_link_id).toBeNull()

      client.close()
    })

    it('wraps GETMEM failures as KakaoTalkError get_members_failed', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(1))
      mockGetAllMembers.mockRejectedValueOnce(new Error('Network error'))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembers('100')
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('get_members_failed')
      }

      client.close()
    })

    it('throws on synthetic disconnect packet from GETMEM (statusCode != 0)', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(1))
      mockGetAllMembers.mockResolvedValueOnce({
        statusCode: -1,
        body: { error: 'connection closed' },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembers('100')
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('get_members_failed')
      }

      client.close()
    })

    it('throws on GETMEM body.status nonzero', async () => {
      mockGetChannelInfo.mockResolvedValueOnce(memberChannelInfo(1))
      mockGetAllMembers.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: -500 },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembers('100')
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('get_members_failed')
      }

      client.close()
    })

    it('getMembersByIds passes parsed Long IDs to MEMBER request', async () => {
      mockGetMembersByIds.mockResolvedValueOnce({
        statusCode: 0,
        body: {
          chatId: makeLong(100),
          members: [{ userId: makeLong(42), nickName: 'Alice', type: 100 }],
        },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const members = await client.getMembersByIds('100', ['42', '43', '99'])

      expect(members).toHaveLength(1)
      expect(members[0].nickname).toBe('Alice')
      expect(mockGetMembersByIds).toHaveBeenCalledTimes(1)

      // Verify the actual LOCO call args, not just the call count: chatId is a
      // Long-shaped { low, high } and memberIds is a list of Longs in the order
      // the SDK consumer passed them. Guards against accidentally sending raw
      // strings or losing IDs — both fail silently server-side.
      const [chatIdArg, memberIdsArg] = mockGetMembersByIds.mock.calls[0] as [
        { low: number; high: number },
        Array<{ low: number; high: number }>,
      ]
      expect(chatIdArg).toMatchObject({ low: 100, high: 0 })
      expect(memberIdsArg).toHaveLength(3)
      expect(memberIdsArg[0]).toMatchObject({ low: 42, high: 0 })
      expect(memberIdsArg[1]).toMatchObject({ low: 43, high: 0 })
      expect(memberIdsArg[2]).toMatchObject({ low: 99, high: 0 })

      client.close()
    })

    it('wraps MEMBER failures as KakaoTalkError get_members_failed', async () => {
      mockGetMembersByIds.mockRejectedValueOnce(new Error('Network error'))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembersByIds('100', ['42'])
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('get_members_failed')
      }

      client.close()
    })

    it('throws on synthetic disconnect packet from MEMBER (statusCode != 0)', async () => {
      mockGetMembersByIds.mockResolvedValueOnce({
        statusCode: -1,
        body: { error: 'connection closed' },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembersByIds('100', ['42'])
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('get_members_failed')
      }

      client.close()
    })

    it('throws on MEMBER body.status nonzero', async () => {
      mockGetMembersByIds.mockResolvedValueOnce({
        statusCode: 0,
        body: { status: -500 },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembersByIds('100', ['42'])
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('get_members_failed')
      }

      client.close()
    })

    it('getMembers throws KakaoTalkError invalid_chat_id without contacting LOCO', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembers('not-a-number')
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_chat_id')
      }
      expect(mockGetAllMembers).not.toHaveBeenCalled()
      expect(mockGetChannelInfo).not.toHaveBeenCalled()
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      expect(mockLogin).not.toHaveBeenCalled()

      client.close()
    })

    it('getMembersByIds throws invalid_chat_id for bad chatId without contacting LOCO', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembersByIds('not-a-number', ['42'])
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_chat_id')
      }
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      expect(mockLogin).not.toHaveBeenCalled()

      client.close()
    })

    it('getMembersByIds throws invalid_user_id for bad userId without contacting LOCO', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      try {
        await client.getMembersByIds('100', ['42', 'bogus', '99'])
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('invalid_user_id')
      }
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      expect(mockLogin).not.toHaveBeenCalled()

      client.close()
    })

    it('getMembersByIds returns [] without contacting LOCO when userIds is empty', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const result = await client.getMembersByIds('100', [])

      expect(result).toEqual([])
      expect(mockGetMembersByIds).not.toHaveBeenCalled()
      expect(mockLogin).not.toHaveBeenCalled()

      client.close()
    })

    it('reconnects and retries getMembers after silent disconnect (full executeWithReconnect path)', async () => {
      // Earlier tests verify assertLocoOk throws on a synthetic-disconnect packet,
      // but they don't exercise the reconnect path: executeWithReconnect only
      // retries when the underlying socket also closed (state.session !== this.state.session).
      // This test fires the captured onClose callback before the rejection so the
      // client's state is nulled, then verifies the operation is retried against
      // a fresh session and the second response is returned to the caller.
      const closeHandlers: Array<() => void> = []
      mockOnClose.mockImplementation((handler: () => void) => {
        closeHandlers.push(handler)
      })

      mockGetAllMembers.mockImplementationOnce(() => {
        // Fire the close handler captured during the first session's setup —
        // simulates the LOCO TCP socket closing while the GETMEM is in flight.
        // executeWithReconnect sees state.session !== this.state.session and retries.
        const handler = closeHandlers[0]
        if (handler) handler()
        return Promise.resolve({ statusCode: -1, body: { error: 'connection closed' } })
      })
      mockGetAllMembers.mockResolvedValue({
        statusCode: 0,
        body: { members: [{ userId: makeLong(42), nickName: 'Alice', type: 100 }] },
      })
      mockGetChannelInfo
        .mockResolvedValueOnce(memberChannelInfo(1))
        .mockResolvedValueOnce(memberChannelInfo(1))
        .mockResolvedValueOnce(memberChannelInfo(1))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      const members = await client.getMembers('100')

      expect(members).toHaveLength(1)
      expect(members[0].nickname).toBe('Alice')
      expect(mockGetAllMembers).toHaveBeenCalledTimes(3)
      expect(mockGetChatInfo).not.toHaveBeenCalled()
      // Login fires twice: once for the initial connect, once for the reconnect
      // after the captured onClose handler invalidated this.state.
      expect(mockLogin).toHaveBeenCalledTimes(2)

      client.close()
    })
  })

  describe('getProfile', () => {
    const mockFetch = mock(() => Promise.resolve(new Response()))

    beforeEach(() => {
      mockFetch.mockReset()
      globalThis.fetch = mockFetch as unknown as typeof fetch
    })

    afterEach(() => {
      mockFetch.mockReset()
    })

    function makeJsonResponse(data: unknown, status = 200): Response {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    it('returns profile data on success', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeJsonResponse({
            profile: {
              nickName: 'Test User',
              profileImageUrl: 'https://example.com/profile.jpg',
              originalProfileImageUrl: 'https://example.com/original.jpg',
              statusMessage: 'Hello world',
            },
          }),
        )
        .mockResolvedValueOnce(makeJsonResponse({ accountDisplayId: 'testuser123' }))

      const client = await new KakaoTalkClient().login({
        oauthToken: 'mytoken',
        userId: 'user42',
        deviceUuid: 'device1',
      })
      const profile = await client.getProfile()

      expect(profile.user_id).toBe('user42')
      expect(profile.nickname).toBe('Test User')
      expect(profile.profile_image_url).toBe('https://example.com/profile.jpg')
      expect(profile.original_profile_image_url).toBe('https://example.com/original.jpg')
      expect(profile.status_message).toBe('Hello world')
      expect(profile.account_display_id).toBe('testuser123')

      client.close()
    })

    it('throws not_authenticated when not logged in', async () => {
      const client = new KakaoTalkClient()
      try {
        await client.getProfile()
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('not_authenticated')
      }
    })

    it('throws profile_request_failed when profile HTTP request fails', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({}, 401))
        .mockResolvedValueOnce(makeJsonResponse({ accountDisplayId: null }))

      const client = await new KakaoTalkClient().login({
        oauthToken: 'mytoken',
        userId: 'user42',
        deviceUuid: 'device1',
      })
      try {
        await client.getProfile()
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(KakaoTalkError)
        expect((e as KakaoTalkError).code).toBe('profile_request_failed')
      }

      client.close()
    })

    it('returns null account_display_id when more_settings request fails', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeJsonResponse({
            profile: {
              nickName: 'Test User',
              profileImageUrl: null,
              originalProfileImageUrl: null,
              statusMessage: null,
            },
          }),
        )
        .mockResolvedValueOnce(makeJsonResponse({}, 500))

      const client = await new KakaoTalkClient().login({
        oauthToken: 'mytoken',
        userId: 'user42',
        deviceUuid: 'device1',
      })
      const profile = await client.getProfile()

      expect(profile.user_id).toBe('user42')
      expect(profile.nickname).toBe('Test User')
      expect(profile.account_display_id).toBeNull()

      client.close()
    })
  })

  describe('session lifecycle', () => {
    it('lazy init: does not call login until first method call', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      expect(mockLogin).not.toHaveBeenCalled()
      client.close()
    })

    it('calls login on first method call', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await client.getChats()
      expect(mockLogin).toHaveBeenCalledTimes(1)
      client.close()
    })

    it('reuses session across multiple calls', async () => {
      mockGetChatLogs.mockResolvedValue({
        body: { status: 0, chatLogs: [], eof: true },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await client.getChats()
      await client.getMessages('100')

      expect(mockLogin).toHaveBeenCalledTimes(1)

      client.close()
    })

    it('concurrent calls share a single login', async () => {
      // Make login take some time
      mockLogin.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(DEFAULT_LOGIN_RESULT), 50)))
      mockGetChatLogs.mockResolvedValue({
        body: { status: 0, chatLogs: [], eof: true },
      })

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await Promise.all([client.getChats(), client.getMessages('100')])

      expect(mockLogin).toHaveBeenCalledTimes(1)

      client.close()
    })

    it('retries login after failure', async () => {
      mockLogin.mockRejectedValueOnce(new Error('Connection refused')).mockResolvedValueOnce(DEFAULT_LOGIN_RESULT)

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })

      // First call fails
      await expect(client.getChats()).rejects.toThrow(KakaoTalkError)

      // Second call retries and succeeds
      const chats = await client.getChats()
      expect(chats).toHaveLength(2)
      expect(mockLogin).toHaveBeenCalledTimes(2)

      client.close()
    })

    it('close cleans up session state', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await client.getChats()

      client.close()
      expect(mockClose).toHaveBeenCalledTimes(1)
    })

    it('methods throw client_closed after close', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await client.getChats()
      client.close()

      try {
        await client.getChats()
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(KakaoTalkError)
        expect((error as KakaoTalkError).code).toBe('client_closed')
      }
    })

    it('close is idempotent', async () => {
      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      client.close()
      expect(() => client.close()).not.toThrow()
    })

    it('login failure closes the session to prevent socket leak', async () => {
      mockLogin.mockRejectedValue(new Error('Auth failed'))

      const client = await new KakaoTalkClient().login({ oauthToken: 'token', userId: 'user1', deviceUuid: 'device1' })
      await expect(client.getChats()).rejects.toThrow()

      // LocoSession.close() should have been called to clean up
      expect(mockClose).toHaveBeenCalledTimes(1)

      client.close()
    })
  })
})

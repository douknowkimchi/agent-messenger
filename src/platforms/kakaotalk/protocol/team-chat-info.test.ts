import { describe, expect, it } from 'bun:test'

import { TeamChatInfoError, decodeTeamChatInfo, getTeamChatInfoOnce } from './team-chat-info'

const BIG = '9007199254740993' // above 2^53: a JS number would read ...992

function http(answer: (url: string, init: RequestInit) => Response | Promise<Response>, timeoutMs?: number) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  return {
    calls,
    http: {
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return answer(url, init)
      },
      authorizedHeaders: { Authorization: 'synthetic-token-device', A: 'android/25.9.2/ko' },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  }
}

const json = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'application/json' } })
const team = (chatId: string, extra = '') =>
  `{"chatId":${chatId},"name":"Synthetic team","description":"About us","hostId":"42","status":"ACTIVE","revision":3,` +
  `"permission":{"INVITE":"STAFF"},"staff":[],"restrictions":[]${extra}}`

describe('getTeamChatInfoOnce', () => {
  it('sends one POST with the exact chat id digits to the fixed team host, no redirect', async () => {
    const fake = http(() => json(200, team(BIG)))
    const info = await getTeamChatInfoOnce(fake.http, BIG)
    expect(info).toEqual({ chat_id: BIG, name: 'Synthetic team', description: 'About us', host_id: '42', status: 'ACTIVE' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].url).toBe('https://talk-pilsner.kakao.com/alcatraz/v1/chat/info')
    expect(fake.calls[0].init.method).toBe('POST')
    expect(fake.calls[0].init.body).toBe(`{"chatId":${BIG}}`)
    expect(fake.calls[0].init.redirect).toBe('manual')
    expect((fake.calls[0].init.headers as Record<string, string>).Authorization).toBe('synthetic-token-device')
  })

  it('names a 404 code 90001 not_team and any other 4xx a refusal', async () => {
    await expect(getTeamChatInfoOnce(http(() => json(404, '{"status":404,"code":"90001"}')).http, '5')).rejects.toMatchObject({ reason: 'not_team' })
    await expect(getTeamChatInfoOnce(http(() => json(404, '{"status":404,"code":"90002"}')).http, '5')).rejects.toMatchObject({ reason: 'rejected' })
    await expect(getTeamChatInfoOnce(http(() => json(403, '{}')).http, '5')).rejects.toMatchObject({ reason: 'rejected' })
  })

  it('reads a redirect, a 5xx, a thrown fetch and a timeout as transport, each sent once', async () => {
    for (const answer of [() => json(302, ''), () => json(503, ''), () => { throw new Error('down') }]) {
      const fake = http(answer)
      await expect(getTeamChatInfoOnce(fake.http, '5')).rejects.toMatchObject({ reason: 'transport' })
      expect(fake.calls).toHaveLength(1)
    }
    const slow = http(() => new Promise<Response>(() => {}), 20)
    await expect(getTeamChatInfoOnce(slow.http, '5')).rejects.toMatchObject({ reason: 'transport' })
    expect(slow.calls).toHaveLength(1)
  })

  it('refuses a malformed chat id before any request', async () => {
    for (const id of ['', '0', '-1', '01', '9223372036854775808', '1.5']) {
      const fake = http(() => json(200, team('1')))
      await expect(getTeamChatInfoOnce(fake.http, id)).rejects.toMatchObject({ reason: 'invalid_request' })
      expect(fake.calls).toHaveLength(0)
    }
  })
})

describe('decodeTeamChatInfo', () => {
  it('compares the chat id by its digits, so a neighbouring id above 2^53 fails', () => {
    expect(() => decodeTeamChatInfo(team('9007199254740992'), BIG)).toThrow(TeamChatInfoError)
    expect(decodeTeamChatInfo(team(BIG), BIG).chat_id).toBe(BIG)
  })

  it('accepts a numeric host id by its digits and an absent intro as empty', () => {
    const text = `{"chatId":7,"name":"n","hostId":${BIG},"status":"ACTIVE"}`
    expect(decodeTeamChatInfo(text, '7')).toEqual({ chat_id: '7', name: 'n', description: '', host_id: BIG, status: 'ACTIVE' })
  })

  it('fails the whole answer for any missing, mistyped or oversized field', () => {
    for (const text of [
      'not json',
      '[]',
      '{"chatId":7,"name":"n","hostId":"42","status":"ACTIVE","chatId":8}',
      '{"chatId":"7","name":"n","hostId":"42","status":"ACTIVE"}',
      '{"chatId":7,"hostId":"42","status":"ACTIVE"}',
      '{"chatId":7,"name":"","hostId":"42","status":"ACTIVE"}',
      '{"chatId":7,"name":"n","hostId":"042","status":"ACTIVE"}',
      '{"chatId":7,"name":"n","hostId":0,"status":"ACTIVE"}',
      '{"chatId":7,"name":"n","hostId":"42"}',
      '{"chatId":7,"name":"n","description":5,"hostId":"42","status":"ACTIVE"}',
      `{"chatId":7,"name":"${'x'.repeat(4097)}","hostId":"42","status":"ACTIVE"}`,
    ]) {
      expect(() => decodeTeamChatInfo(text, '7')).toThrow(TeamChatInfoError)
    }
  })
})

import { describe, expect, it } from 'bun:test'

import { KakaoTalkClient } from './client'

// Synthetic account values; the injected fetch is the only network.
const TOKEN = 'synthetic-oauth'
const DEVICE = 'synthetic-device-uuid'

function fixture(answer: () => Response, signedIn = true) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const client = new KakaoTalkClient()
  let sessions = 0
  Object.assign(client, {
    oauthToken: signedIn ? TOKEN : null,
    userId: signedIn ? '4242' : null,
    deviceUuid: DEVICE,
    deviceType: 'tablet',
    mediaIo: { fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer() } },
    ensureSession: async () => { sessions++; throw new Error('no LOCO session is used') },
  })
  return { client, calls, sessions: () => sessions }
}

describe('KakaoTalkClient bubble reactions', () => {
  it('sends one change with the account headers and no LOCO session', async () => {
    const { client, calls, sessions } = fixture(() => new Response('{"status":0}', { status: 200 }))
    expect(await client.setBubbleReactionOnce('40005', '9007199254740993', 3)).toEqual({ outcome: 'accepted' })
    expect(calls).toHaveLength(1)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`${TOKEN}-${DEVICE}`)
    expect(headers['talk-user-id']).toBe('4242')
    expect(headers['Content-Type']).toBe('application/json')
    expect(String(calls[0]!.init.body)).toStartWith('{"logId":9007199254740993,"type":3,"reqId":')
    expect(sessions()).toBe(0)
  })

  it('reads members once', async () => {
    const { client, calls } = fixture(() => new Response('{"revision":7,"1":[4242]}', { status: 200 }))
    const read = await client.getBubbleReactionMembers('40005', '50005')
    expect(read.revision).toBe('7')
    expect(read.members['1']).toEqual(['4242'])
    expect(calls).toHaveLength(1)
  })

  it('does not send without a signed-in account', async () => {
    const { client, calls } = fixture(() => new Response('{"status":0}'), false)
    expect(await client.setBubbleReactionOnce('40005', '50005', 1)).toEqual({ outcome: 'not_sent' })
    await expect(client.getBubbleReactionMembers('40005', '50005')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('sends nothing once the client is closed', async () => {
    const { client, calls } = fixture(() => new Response('{"status":0}'))
    Object.assign(client, { closed: true })
    expect(await client.setBubbleReactionOnce('40005', '50005', 1)).toEqual({ outcome: 'not_sent' })
    await expect(client.getBubbleReactionMembers('40005', '50005')).rejects.toThrow('closed')
    expect(calls).toHaveLength(0)
  })
})

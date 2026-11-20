import { describe, expect, it } from 'bun:test'

import {
  BubbleReactionReadError,
  type BubbleReactionHttp,
  decodeBubbleReactionMembers,
  getBubbleReactionMembers,
  setBubbleReactionOnce,
} from './bubble-reactions'

// Synthetic identifiers and credentials only; no request leaves the process.
const TOKEN_HEADERS = { Authorization: 'synthetic-token-device', A: 'win32/26.0.0/ko' }
const BIG_CHAT = '9223372036854775801'
const BIG_LOG = '9007199254740993' // 2^53 + 1: not representable as a JavaScript number

interface Call { url: string; init: RequestInit }

function fakeHttp(answer: () => Promise<Response> | Response): { http: BubbleReactionHttp; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    http: {
      authorizedHeaders: TOKEN_HEADERS,
      timeoutMs: 200,
      fetch: async (url, init) => {
        calls.push({ url, init })
        return answer()
      },
    },
  }
}

const json = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'application/json' } })

describe('setBubbleReactionOnce', () => {
  it('posts the exact log id digits once to the chat path, without following redirects', async () => {
    const { http, calls } = fakeHttp(() => json(200, '{"status":0}'))
    expect(await setBubbleReactionOnce(http, BIG_CHAT, BIG_LOG, 1, 1763600000000)).toEqual({ outcome: 'accepted' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://talk-pilsner.kakao.com/messaging/chats/${BIG_CHAT}/bubble/reactions`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.redirect).toBe('manual')
    expect(calls[0]!.init.body).toBe(`{"logId":${BIG_LOG},"type":1,"reqId":1763600000000}`)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('synthetic-token-device')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('sends type 0 as the cancellation', async () => {
    const { http, calls } = fakeHttp(() => json(200, '{"result":true}'))
    expect(await setBubbleReactionOnce(http, '40005', '50005', 0, 1)).toEqual({ outcome: 'accepted' })
    expect(calls[0]!.init.body).toBe('{"logId":50005,"type":0,"reqId":1}')
  })

  it('refuses invalid input before any request', async () => {
    const { http, calls } = fakeHttp(() => json(200, '{"status":0}'))
    for (const [chat, log, kind, req] of [
      ['0', '1', 1, 1], ['01', '1', 1, 1], ['1', '9223372036854775808', 1, 1], ['1', '-1', 1, 1],
      ['1', '1', 7, 1], ['1', '1', -1, 1], ['1', '1', 1.5, 1], ['1', '1', 1, 0], ['1', '1', 1, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expect(await setBubbleReactionOnce(http, chat, log, kind as never, req)).toEqual({ outcome: 'not_sent' })
    }
    expect(calls).toHaveLength(0)
  })

  it('classifies answers and never retries', async () => {
    const cases: Array<[() => Response | Promise<Response>, unknown]> = [
      [() => json(200, '{"status":0,"result":true}'), { outcome: 'accepted' }],
      [() => json(200, '{"status":0,"result":false}'), { outcome: 'rejected', providerStatus: null }],
      [() => json(200, '{"status":-805}'), { outcome: 'rejected', providerStatus: -805 }],
      [() => json(200, '{"result":false}'), { outcome: 'rejected', providerStatus: null }],
      [() => json(403, '{"status":-401}'), { outcome: 'rejected', providerStatus: null }],
      [() => json(500, '{"status":0}'), { outcome: 'unknown' }],
      [() => new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }), { outcome: 'unknown' }],
      [() => json(200, '{}'), { outcome: 'unknown' }],
      [() => json(200, '{"status":"0"}'), { outcome: 'unknown' }],
      [() => json(200, '{"status":0,"status":1}'), { outcome: 'unknown' }],
      [() => json(200, '[]'), { outcome: 'unknown' }],
      [() => json(200, 'not json'), { outcome: 'unknown' }],
      [() => json(200, `{"status":0,"pad":"${'x'.repeat(1 << 20)}"}`), { outcome: 'unknown' }],
      [() => Promise.reject(new Error('socket reset')), { outcome: 'unknown' }],
      [() => new Promise<Response>(() => {}), { outcome: 'unknown' }],
    ]
    for (const [answer, expected] of cases) {
      const { http, calls } = fakeHttp(answer)
      expect(await setBubbleReactionOnce(http, '40005', '50005', 2, 1)).toEqual(expected as never)
      expect(calls).toHaveLength(1)
    }
  })

  it('puts no credential or body into a failure', async () => {
    const { http } = fakeHttp(() => Promise.reject(new Error('synthetic-token-device leaked')))
    const result = await setBubbleReactionOnce(http, '40005', '50005', 2, 1)
    expect(JSON.stringify(result)).not.toContain('synthetic-token')
  })
})

describe('members', () => {
  it('reads every id exactly, including ids above 2^53', async () => {
    const { http, calls } = fakeHttp(() =>
      json(200, `{"revision":9223372036854775806, "1" : [${BIG_LOG},20002],"3":[],"7":[1],"other":{"a":1.5,"s":"#1"}}`))
    const read = await getBubbleReactionMembers(http, BIG_CHAT, BIG_LOG)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://talk-pilsner.kakao.com/messaging/chats/${BIG_CHAT}/bubble/reactions/${BIG_LOG}/members`)
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.redirect).toBe('manual')
    expect(read).toEqual({
      revision: '9223372036854775806',
      members: { '1': [BIG_LOG, '20002'], '2': [], '3': [], '4': [], '5': [], '6': [] },
    })
  })

  it('treats a missing or zero revision as null and an empty answer as confirmed empty', () => {
    expect(decodeBubbleReactionMembers('{}').revision).toBeNull()
    expect(decodeBubbleReactionMembers('{"revision":0,"1":[],"note":"x"}')).toEqual({
      revision: null, members: { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] },
    })
  })

  it('fails the whole answer on any malformed general kind', () => {
    for (const body of [
      '{"1":"20002"}', '{"1":[0]}', '{"1":[-5]}', '{"1":["20002"]}', '{"1":[1.5]}', '{"1":[9223372036854775808]}',
      '{"1":[20002],"2":[20002]}', '{"1":[20002,20002]}', '{"revision":-1}', '{"revision":"3"}', '{"1":[1],"1":[2]}',
      '[1]', 'nope', '{"1":null}', '{"revision":null}', '{"revision":"#9","1":["#4242"]}', '{"1":["#4242"]}',
      '{"revision":"#9"}', '{"1":[{"a":1}]}', '{"1":[true]}',
    ]) {
      expect(() => decodeBubbleReactionMembers(body)).toThrow(BubbleReactionReadError)
    }
  })

  it('reports transport, refusal and server failures without a list', async () => {
    for (const [answer, reason] of [
      [() => Promise.reject(new Error('x')), 'transport'],
      [() => json(401, '{}'), 'rejected'],
      [() => json(502, '{}'), 'transport'],
      [() => new Response(null, { status: 301 }), 'transport'],
    ] as const) {
      const { http, calls } = fakeHttp(answer as never)
      await expect(getBubbleReactionMembers(http, '40005', '50005')).rejects.toMatchObject({ reason })
      expect(calls).toHaveLength(1)
    }
    const { http, calls } = fakeHttp(() => json(200, '{}'))
    await expect(getBubbleReactionMembers(http, '40005', '0')).rejects.toMatchObject({ reason: 'invalid_request' })
    expect(calls).toHaveLength(0)
  })
})
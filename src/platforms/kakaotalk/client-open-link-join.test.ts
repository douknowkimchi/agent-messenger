import { describe, expect, it } from 'bun:test'

import { Long } from 'bson'

import { KakaoTalkClient } from './client'
import { LocoConnection } from './protocol/connection'
import { LocoSession } from './protocol/session'

// Synthetic values only. A real LocoSession is driven over a recording
// connection, so the packet each method sends is the one asserted.
const SELF = '4242'
const URL = 'https://open.kakao.com/o/gAbC1234'
const LINK = '9223372036854775001'

type Answer = { statusCode?: number; body?: unknown } | Error

function fixture(answers: Answer[]) {
  const sent: Array<{ method: string; body: Record<string, unknown> }> = []
  const connection = {
    sendPacket: async (method: string, body: Record<string, unknown>) => {
      sent.push({ method, body })
      const answer = answers.shift()
      if (!answer) throw new Error('unexpected packet')
      if (answer instanceof Error) throw answer
      return { packetId: sent.length, statusCode: 0, method, bodyType: 0, ...answer }
    },
  } as unknown as LocoConnection
  const session = new LocoSession()
  Object.assign(session, { connection })
  const client = new KakaoTalkClient()
  const state = { session }
  Object.assign(client, { state, userId: SELF, closed: false })
  return { client, sent, replace: () => Object.assign(client, { state: { session: new LocoSession() } }) }
}

const ol = (extra: Record<string, unknown> = {}) => ({
  li: Long.fromString(LINK), lt: 2, ac: true, ln: 'Synthetic room', lu: URL, desc: 'about',
  olu: { userId: Long.fromString('9007199254740995'), nn: 'Host' }, ml: 300, pv: Long.fromNumber(32), ...extra,
})

describe('KakaoTalkClient open link invite preview', () => {
  it('asks JOININFO once with the exact invite URL and keeps the link id exact', async () => {
    const { client, sent } = fixture([{ body: { status: 0, ol: ol() } }])
    await expect(client.getOpenLinkJoinInfoOnce(URL)).resolves.toEqual({
      link_id: LINK, link_type: 2, active: true, owner_user_id: '9007199254740995', any_profile_allowed: true,
      link_url: URL, name: 'Synthetic room', description: 'about', owner_nickname: 'Host', member_limit: 300,
    })
    expect(sent).toEqual([{ method: 'JOININFO', body: { lu: URL, ref: 'EW' } }])
  })

  for (const url of ['http://open.kakao.com/o/gAbC1234', 'https://open.kakao.com/w/abc/def', `${URL}?x=1`, `${URL}/`,
    'https://open.kakao.com.evil.example/o/gAbC1234', 'https://open.kakao.com/o/', 'https://open.kakao.com/o/a b']) {
    it(`sends nothing for a URL that is not an exact invite: ${url}`, async () => {
      const { client, sent } = fixture([])
      await expect(client.getOpenLinkJoinInfoOnce(url)).rejects.toMatchObject({ code: 'invalid_open_link_url' })
      expect(sent).toHaveLength(0)
    })
  }

  it('keeps a provider refusal as a refusal with its status', async () => {
    const { client, sent } = fixture([{ body: { status: -803 } }])
    await expect(client.getOpenLinkJoinInfoOnce(URL)).rejects.toMatchObject({
      code: 'get_open_link_join_info_failed', responseFailureKind: 'provider_rejection', serverStatus: -803,
    })
    expect(sent).toHaveLength(1)
  })

  for (const [label, body] of [
    ['no link', { status: 0 }],
    ['no success status', { ol: ol() }],
    ['a link id that is not canonical', { status: 0, ol: ol({ li: 0 }) }],
    ['no type', { status: 0, ol: ol({ lt: undefined }) }],
    ['no activation', { status: 0, ol: ol({ ac: 'yes' }) }],
    ['no owner', { status: 0, ol: ol({ olu: undefined }) }],
    ['no name', { status: 0, ol: ol({ ln: 7 }) }],
  ] as const) {
    it(`refuses an answer with ${label} as unknown, without retry`, async () => {
      const { client, sent } = fixture([{ body }])
      await expect(client.getOpenLinkJoinInfoOnce(URL)).rejects.toMatchObject({
        code: 'get_open_link_join_info_failed', responseFailureKind: 'transient_or_unknown',
      })
      expect(sent).toHaveLength(1)
    })
  }

  it('reports optional fields it cannot use as null and an answered URL as answered', async () => {
    const { client } = fixture([{ body: { status: 0, ol: ol({ lu: 'https://example.com/o/x', desc: 3, ml: -1, pv: undefined, olu: { userId: 7 } }) } }])
    await expect(client.getOpenLinkJoinInfoOnce(URL)).resolves.toMatchObject({
      link_url: 'https://example.com/o/x', description: null, member_limit: null, any_profile_allowed: null, owner_nickname: null, owner_user_id: '7',
    })
    const absent = fixture([{ body: { status: 0, ol: ol({ lu: undefined }) } }])
    await expect(absent.client.getOpenLinkJoinInfoOnce(URL)).resolves.toMatchObject({ link_url: null })
  })

  it('refuses a late answer after the session was replaced', async () => {
    let release: (value: unknown) => void = () => {}
    const { client, replace } = fixture([])
    const session = (client as unknown as { state: { session: LocoSession } }).state.session
    Object.assign(session, { connection: { sendPacket: () => new Promise(resolve => { release = resolve }) } })
    const pending = client.getOpenLinkJoinInfoOnce(URL)
    replace()
    release({ statusCode: 0, body: { status: 0, ol: ol() } })
    await expect(pending).rejects.toMatchObject({ code: 'get_open_link_join_info_failed' })
  })

  it('never acquires a session when none is ready', async () => {
    const client = new KakaoTalkClient()
    await expect(client.getOpenLinkJoinInfoOnce(URL)).rejects.toMatchObject({ code: 'get_open_link_join_info_failed' })
    await expect(client.listOwnOpenProfilesOnce()).rejects.toMatchObject({ code: 'list_own_open_profiles_failed' })
  })
})

describe('KakaoTalkClient own open profiles', () => {
  const item = (li: string, extra: Record<string, unknown> = {}) => ({
    li: Long.fromString(li), lt: 1, ac: true, ln: `Profile ${li}`, olu: { userId: Number(SELF), nn: `Nick ${li}` }, ...extra,
  })

  it('asks SYNCLINK once from token 0 and keeps only active profile links this account owns', async () => {
    const { client, sent } = fixture([{ body: { status: 0, ltk: 9, ols: [
      item('9223372036854775002'),
      item('11', { lt: 2 }),
      item('12', { ac: false }),
      item('13', { olu: { userId: 99, nn: 'Other' } }),
      item('14', { olu: { userId: Number(SELF), nn: '' } }),
    ] } }])
    await expect(client.listOwnOpenProfilesOnce()).resolves.toEqual([
      { link_id: '9223372036854775002', name: 'Profile 9223372036854775002', nickname: 'Nick 9223372036854775002' },
      { link_id: '14', name: 'Profile 14', nickname: null },
    ])
    expect(sent).toEqual([{ method: 'SYNCLINK', body: { ltk: 0 } }])
  })

  it('answers an empty list when Kakao lists none', async () => {
    const { client } = fixture([{ body: { status: 0, ltk: 0 } }])
    await expect(client.listOwnOpenProfilesOnce()).resolves.toEqual([])
  })

  for (const [label, ols] of [
    ['an entry without an id', [item('5', { li: 0 })]],
    ['a duplicated link', [item('5'), item('5')]],
    ['an entry without an owner', [item('5', { olu: null })]],
    ['a list that is not a list', { li: 5 }],
  ] as const) {
    it(`refuses the whole answer for ${label}`, async () => {
      const { client } = fixture([{ body: { status: 0, ols } }])
      await expect(client.listOwnOpenProfilesOnce()).rejects.toMatchObject({ code: 'list_own_open_profiles_failed' })
    })
  }

  it('refuses an answer without a success status instead of reading it as no profiles', async () => {
    const { client } = fixture([{ body: {} }])
    await expect(client.listOwnOpenProfilesOnce()).rejects.toMatchObject({ code: 'list_own_open_profiles_failed' })
  })

  it('keeps a provider refusal with its status', async () => {
    const { client } = fixture([{ statusCode: -500, body: {} }])
    await expect(client.listOwnOpenProfilesOnce()).rejects.toMatchObject({
      code: 'list_own_open_profiles_failed', responseFailureKind: 'provider_rejection', serverStatus: -500,
    })
  })
})

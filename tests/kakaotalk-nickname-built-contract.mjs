import assert from 'node:assert/strict'
import test from 'node:test'
import { Long } from 'bson'
import { encodePacket, decodePacket } from '../dist/src/platforms/kakaotalk/protocol/packet.js'
import { KakaoTalkClient } from '../dist/src/platforms/kakaotalk/client.js'
import { buildJoinOpenLinkBody } from '../dist/src/platforms/kakaotalk/protocol/session.js'
import { KakaoMemberSchema } from '../dist/src/platforms/kakaotalk/types.js'

const long = n => ({ low: n, high: 0 })
const sdk = session => Object.assign(new KakaoTalkClient(), {
  state: { session }, oauthToken: 'SYNTHETIC', userId: '1', isConnected: () => true,
})
const base = { userId: long(1), nickName: '합성 닉네임', ptp: 2,
  pi: 'https://open.kakaocdn.net/dn/synthetic/key/img_s.jpg' }

test('C1 nickname controls cannot be projected or dispatched', async () => {
  let joins = 0
  const client = sdk({
    async getMembersByIds() { return { statusCode: 0, body: { chatId: long(5),
      members: [{ ...base, nickName: '가\u0085나' }] } } },
    async joinOpenLink() { joins++; return {} },
  })
  const result = await client.getSelectedMembersOnce('5', ['1'])
  const member = Array.isArray(result) ? result[0] : result.members[0]
  assert.equal(member.open_nickname_profile, undefined)
  await assert.rejects(client.joinOpenDirectOnce('7', {
    kind: 'anonymous', nickname: '가\u0085나', profile_path: 'synthetic/key',
  }), { code: 'invalid_open_profile' })
  assert.equal(joins, 0)
})

test('exact provider privilege mask distinguishes allowed, denied and unknown', async () => {
  for (const [pv, expected] of [[32,true],[33,true],[0,false],[64,false],
    [undefined,null],[null,null],['32',null],[-1,null],[32.1,null],[2**53,null]]) {
    let calls = 0
    const client = sdk({ async getOpenLinkInfo() { calls++; return { statusCode: 0,
      body: { ols: [{ li: long(7), lt: 1, ac: true, pv, olu: { userId: long(2) } }] } } } })
    assert.equal((await client.getOpenLink('7')).any_profile_allowed, expected)
    assert.equal(calls, 1)
  }
})

test('only exact canonical same-resource CDN images yield a reusable nickname profile', async () => {
  const cases = [
    [base,true], [{...base,opi:'http://open.kakaocdn.net/dn/synthetic/key/img.jpg'},true],
    [{...base,ptp:1},false], [{...base,ptp:4},false], [{...base,nickName:''},false],
    [{...base,nickName:'x'.repeat(81)},false], [{...base,nickName:'bad\nname'},false],
    [{...base,pi:null},false], [{...base,pi:'https://open.kakaocdn.net.evil/dn/key/img.jpg'},false],
    [{...base,pi:'https://open.kakaocdn.net/dn/synthetic/key/img_s.jpg?x=1'},false],
    [{...base,pi:'https://open.kakaocdn.net/dn/a/../key/img.jpg'},false],
    [{...base,pi:'https://open.kakaocdn.net/dn/a%2Fb/img.jpg'},false],
    [{...base,fpi:'https://open.kakaocdn.net/dn/other/key/img_l.jpg'},false],
  ]
  for (const [row, expected] of cases) {
    let calls=0
    const client=sdk({async getMembersByIds() {calls++;return {statusCode:0,body:{chatId:long(5),members:[row]}}}})
    const result=await client.getSelectedMembersOnce('5',['1'])
    const member=Array.isArray(result)?result[0]:result.members[0]
    assert.equal(member.open_nickname_profile !== undefined,expected)
    if(expected) assert.deepEqual(KakaoMemberSchema.parse(member).open_nickname_profile,
      {nickname:base.nickName,profile_path:'synthetic/key'})
    assert.equal(calls,1)
  }
})

test('nickname packet preserves exact nn/pp and response loss never repeats JOIN', async () => {
  const profile={kind:'anonymous',nickname:base.nickName,profile_path:'synthetic/key'}
  const calls=[]
  const client=sdk({async joinOpenLink(link, wire) {calls.push(buildJoinOpenLinkBody(link,wire));throw new Error('synthetic lost')}})
  await assert.rejects(client.joinOpenDirectOnce('7',profile),{code:'join_open_direct_unknown'})
  assert.equal(calls.length,1)
  assert.equal(String(calls[0].li),'7')
  assert.deepEqual({...calls[0],li:null},{li:null,ref:'EW:',ptp:2,nn:base.nickName,pp:'synthetic/key'})
  for(const invalid of [{...profile,nickname:''},{...profile,profile_path:'https://example.test/image'},
    {...profile,profile_path:'a/../b'},{...profile,nickname:'\ud800'}]) {
    await assert.rejects(client.joinOpenDirectOnce('7',invalid),{code:'invalid_open_profile'})
  }
  assert.equal(calls.length,1)
})

// node-kakao 8512e469 defines OpenLinkStruct.pv as BSON Long. Exercise the
// SDK packet decoder, not a numeric-only mock: large masks remain Long.
for (const [label, mask, expected, decodedKind] of [
  ['small allowed', 32n, true, 'number'],
  ['small restricted', 0n, false, 'number'],
  ['large allowed', (1n << 60n) | 32n, true, 'object'],
  ['large restricted', 1n << 60n, false, 'object'],
  ['max positive signed', (1n << 63n) - 1n, true, 'object'],
  ['negative', -1n, null, 'number'],
]) {
  test(`INFOLINK wire privilege ${label} keeps exact permission`, async () => {
    let reads = 0
    const response = decodePacket(encodePacket({ packetId: 1, statusCode: 0,
      method: 'INFOLINK', bodyType: 0,
      body: { ols: [{ li: Long.fromInt(7), lt: 1, ac: true,
        pv: Long.fromString(mask.toString()), olu: { userId: Long.fromInt(2) } }] },
    }))
    assert.ok(response)
    assert.equal(typeof response.packet.body.ols[0].pv, decodedKind)
    const client = sdk({ async getOpenLinkInfo() { reads++; return response.packet } })
    assert.equal((await client.getOpenLink('7')).any_profile_allowed, expected)
    assert.equal(reads, 1)
  })
}

for (const [label, pv, expected] of [
  ['Long allowed', Long.fromInt(32), true],
  ['Long zero', Long.ZERO, false],
  ['Long restricted', Long.fromInt(64), false],
  ['validated words', { low: 32, high: 268435456 }, true],
  ['signed low word', { low: -1, high: 0 }, true],
  ['negative Long', Long.NEG_ONE, null],
  ['unsigned out of signed range', Long.fromString('9223372036854775840', true), null],
  ['fractional word', { low: 32.5, high: 0 }, null],
  ['oversized word', { low: 4294967328, high: 0 }, null],
  ['string word', { low: '32', high: 0 }, null],
  ['missing word', { low: 32 }, null],
  ['array with words', Object.assign([], { low: 32, high: 0 }), null],
  ['numeric text', '32', null],
  ['raw bigint', 32n, null],
]) {
  test(`INFOLINK decoded privilege ${label} is validated without coercion`, async () => {
    const client = sdk({ async getOpenLinkInfo() { return { statusCode: 0,
      body: { ols: [{ li: long(7), lt: 1, ac: true, pv, olu: { userId: long(2) } }] } } } })
    assert.equal((await client.getOpenLink('7')).any_profile_allowed, expected)
  })
}

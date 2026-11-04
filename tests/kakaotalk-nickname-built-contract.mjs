import assert from 'node:assert/strict'
import test from 'node:test'
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

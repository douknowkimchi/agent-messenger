import assert from 'node:assert/strict'
import test from 'node:test'
import { KakaoTalkClient } from '../dist/src/platforms/kakaotalk/client.js'
import { KakaoMemberSchema } from '../dist/src/platforms/kakaotalk/types.js'

// Actual compiled candidate, synthetic existing session only: no login/socket.
const long = n => ({ low: n, high: 0 })
function client(session) {
  const result = new KakaoTalkClient()
  Object.assign(result, { state: { session }, oauthToken: 'synthetic', userId: '1' })
  return result
}
test('compiled member formatter preserves only explicit positive integer ptp and existing optional schema semantics', async () => {
  const values = [1, 2, 4, 8, 16, undefined, null, '1', 1.5, 0, -1]
  const rows = values.map((ptp, i) => ({ userId: long(i + 1), nickName: `Fixture ${i}`,
    ...(ptp === undefined ? {} : { ptp }) }))
  let chat = 0, getmem = 0
  const sdk = client({
    async getChannelInfo() { chat++; return { statusCode: 0, body: { chatInfo: {
      chatId: long(100), activeMembersCount: rows.length, displayMembers: rows.slice(0, 2),
    } } } },
    async getAllMembers() { getmem++; return { statusCode: 0, body: { members: rows } } },
  })
  const result = await sdk.getMemberSnapshot('100')
  assert.deepEqual([chat, getmem], [2, 2])
  result.members.forEach((member, i) => {
    const expected = i < 5 ? values[i] : undefined
    assert.equal(member.open_profile_type, expected)
    assert.equal(Object.hasOwn(member, 'open_profile_type'), expected !== undefined)
    assert.equal(KakaoMemberSchema.parse(member).open_profile_type, expected)
  })
})
test('compiled own olu adapter retains ptp without inventing a type when omitted; dispatch remains one entry', async () => {
  for (const ptp of [1, 2, 4, 16, undefined]) {
    let entries = 0, chats = 0
    const sdk = client({
      async getChannelInfo() { chats++; return { statusCode: 0, body: { chatInfo: {
        chatId: long(100), activeMembersCount: 2, displayMembers: [{ userId: long(2), nickName: 'Peer' }],
      } } } },
      async enterRoom() { entries++; return { statusCode: 0, body: { c: long(100),
        m: [{ userId: long(2), nickName: 'Peer' }],
        olu: { userId: long(1), nn: 'Self', ...(ptp === undefined ? {} : { ptp }) },
      } } },
    })
    const snapshot = await sdk.enterRoomMemberSnapshot('100')
    assert.equal(snapshot.members.find(m => m.user_id === '1').open_profile_type, ptp)
    assert.equal(snapshot.members.find(m => m.user_id === '2').open_profile_type, undefined)
    assert.deepEqual([entries, chats], [1, 2])
  }
})

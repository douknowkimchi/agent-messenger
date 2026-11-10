import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BSON, Long, Int32 } from 'bson'
import { KakaoTalkClient } from './client'
import { LocoSession } from './protocol/session'
import { encodePacket } from './protocol/packet'
import type { LocoPacket } from './protocol/types'

const packet = (body: Record<string, unknown> = { isOK: true }, statusCode = 0): LocoPacket =>
  ({ packetId: 1, statusCode, method: 'SYNCMSG', bodyType: 0, body })
function fixture() {
  const client = new KakaoTalkClient({ connectionAdmission: () => { assert.fail('login forbidden') } })
  const session = new LocoSession()
  const writes: { method: string; body: Record<string, unknown> }[] = []
  let acquisitions = 0
  let response: () => Promise<LocoPacket> = async () => packet()
  Object.assign(session, { connection: { sendPacket: async (method: string, body: Record<string, unknown>) => {
    writes.push({ method, body }); return response()
  }, close() {} } })
  const state = { session, loginResult: {} }
  Object.assign(client, { state, ensureSession: async () => { acquisitions++; return state } })
  return { client, session, state, writes, acquisitions: () => acquisitions,
    respond: (fn: typeof response) => { response = fn },
    replace: () => { Object.assign(client, { state: { session: new LocoSession() } }) } }
}

for (const kind of ['direct','group','open-direct','open-group']) {
  test(`SYNCMSG ${kind}: actual session and BSON encoder send exact empty range once`, async () => {
    const f = fixture()
    const result = await f.client.syncReadOnce('9007199254740993', '18446744073709551615')
    assert.deepEqual(result, { success: true, status_code: 0, applied: true,
      chat_id: '9007199254740993', target_log_id: '18446744073709551615' })
    assert.equal(f.writes.length, 1); assert.equal(f.acquisitions(), 1)
    const sent = f.writes[0]!; assert.equal(sent.method, 'SYNCMSG')
    const bytes = encodePacket({ ...packet(), ...sent })
    const decoded = BSON.deserialize(bytes.subarray(22), { promoteValues: false })
    assert.deepEqual(Object.keys(decoded).sort(), ['chatId','cnt','cur','max'])
    assert.equal(decoded.chatId.toUnsigned().toString(), '9007199254740993')
    assert.equal(decoded.cur.toUnsigned().toString(), '18446744073709551615')
    assert.equal(decoded.max.toUnsigned().toString(), '18446744073709551615')
    assert.ok(decoded.cnt instanceof Int32); assert.equal(decoded.cnt.valueOf(), 0)
  })
}
for (const invalid of ['', '0', '-1', '01', '1.0', ' 1', '18446744073709551616', 9007199254740992, null]) {
  for (const field of ['room','target']) test(`invalid ${field} ${JSON.stringify(invalid)} has zero dispatch`, async () => {
    const f = fixture()
    await assert.rejects(f.client.syncReadOnce(field === 'room' ? invalid as string : '1', field === 'target' ? invalid as string : '2'))
    assert.equal(f.writes.length, 0); assert.equal(f.acquisitions(), 0)
  })
}
for (const value of [true, false]) test(`isOK=${value} alone determines valid applied verdict`, async () => {
  const f = fixture(); f.respond(async () => packet({ isOK: value, status: 0, chatLogs: [] }))
  assert.equal((await f.client.syncReadOnce('1','2')).applied, value)
  assert.equal(f.writes.length, 1)
})
for (const body of [{}, {isOK:null}, {isOK:1}, {isOK:'true'}, {isOK:true,status:'0'},
  {isOK:true,status:-1}, {isOK:true,chatLogs:{}}, {isOK:true,chatLogs:[null]},
  {isOK:true,chatLogs:[{chatId:'2',logId:'1'}]}]) {
  test(`malformed result ${JSON.stringify(body)} is unknown without replay`, async () => {
    const f = fixture(); f.respond(async () => packet(body))
    await assert.rejects(f.client.syncReadOnce('1','2'))
    assert.equal(f.writes.length, 1); assert.equal(f.acquisitions(),1)
  })
}
for (const code of [-1, 500, NaN]) test(`header ${code} cannot apply`, async () => {
  const f=fixture();f.respond(async()=>packet({isOK:true},code))
  await assert.rejects(f.client.syncReadOnce('1','2'));assert.equal(f.writes.length,1)
})
for (const stage of ['before','acquiring','after-dispatch','replace','closed','lost']) {
 test(`cancel/session ${stage} never replays or returns late success`,async()=>{
  const f=fixture(); const abort=new AbortController()
  if(stage==='before')abort.abort()
  if(stage==='acquiring')Object.assign(f.client,{ensureSession:async()=>{f.replace();return f.state}})
  f.respond(async()=>{
    if(stage==='after-dispatch')abort.abort()
    if(stage==='replace')f.replace()
    if(stage==='closed')f.client.close()
    if(stage==='lost')throw new Error('synthetic response loss')
    return packet()
  })
  await assert.rejects(f.client.syncReadOnce('1','2',{signal:abort.signal}))
  assert.equal(f.writes.length, ['before','acquiring'].includes(stage)?0:1)
 })
}
test('late success after pending response and session replacement is refused',async()=>{
 const f=fixture();let release!:(v:LocoPacket)=>void
 f.respond(()=>new Promise(resolve=>{release=resolve}))
 const result=f.client.syncReadOnce('1','2');await new Promise(resolve=>setImmediate(resolve))
 f.replace();release(packet());await assert.rejects(result);assert.equal(f.writes.length,1)
})
test('closed/current session absent is explicitly not dispatched without acquisition',async()=>{
 const f=fixture();f.client.close()
 await assert.rejects(f.client.syncReadOnce('1','2'),{code:'sync_read_not_dispatched'})
 assert.equal(f.writes.length,0);assert.equal(f.acquisitions(),0)
})
test('valid returned diagnostic logs are neither application proof nor persisted history',async()=>{
 const f=fixture();f.respond(async()=>packet({isOK:false,chatLogs:[{chatId:Long.ONE,logId:Long.fromNumber(2),message:'synthetic'}]}))
 const r=await f.client.syncReadOnce('1','2');assert.equal(r.applied,false)
 assert.equal('chatLogs' in r,false);assert.equal(f.writes.length,1)
})

for (const method of ['markRead', 'markReadOnce'] as const) test(`unchanged legacy ${method} still sends only NOTIREAD`, async () => {
  const f = fixture(); f.respond(async () => packet({ status: 0 }))
  const result = await f.client[method]('1','2')
  assert.equal(result.success, true); assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0]!.method, 'NOTIREAD')
})

test('acquisition rejection is known not dispatched rather than unknown', async () => {
  const f = fixture()
  Object.assign(f.client, { ensureSession: async () => { throw Object.assign(new Error('closed during acquisition'), {code:'client_closed'}) } })
  await assert.rejects(f.client.syncReadOnce('1','2'), (e: any) => e.code === 'sync_read_not_dispatched')
  assert.equal(f.writes.length, 0)
})

import { describe, expect, it } from 'bun:test'

import { Int32, Long } from 'bson'

import type { KakaoSessionEventHandler, KakaoPushHandler, KakaoTalkClient } from './client'
import { KakaoTalkListener } from './listener'
import { decodePacket, encodePacket } from './protocol/packet'
import { LOCO_BODY_TYPE_BSON } from './protocol/types'
import { decodeReactionPush } from './reaction-meta'
import type { KakaoTalkPushGenericEvent, KakaoTalkPushReactionEvent } from './types'

// Synthetic identifiers only. Bodies go through the real LOCO packet encoder
// and decoder, so int64 fields arrive as the decoder delivers them (a number
// when safe, a Long object otherwise).
function wire(body: Record<string, unknown>): Record<string, unknown> {
  const bytes = encodePacket({ packetId: 7, statusCode: 0, method: 'CHGLOGMETA', bodyType: LOCO_BODY_TYPE_BSON, body })
  return decodePacket(bytes)!.packet.body
}

const BIG = '9223372036854775807'
const BIG_MINUS_ONE = '9223372036854775806'

function legacy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: Long.fromString(BIG),
    logId: Long.fromString(BIG_MINUS_ONE),
    type: new Int32(1),
    revision: Long.fromString('9007199254740993'),
    content: '{"3":2,"1":1}',
    extra: '{"my":1,"userId":1000,"type":1}',
    ...overrides,
  }
}

class FakeClient {
  pushHandlers = new Set<KakaoPushHandler>()
  sessionHandlers = new Set<KakaoSessionEventHandler>()
  async acquireSession(): Promise<unknown> { return {} }
  isConnected(): boolean { return true }
  getCredentials() { return { oauthToken: 't', userId: 'u', deviceUuid: 'd', deviceType: 'tablet' as const } }
  onPush(handler: KakaoPushHandler) { this.pushHandlers.add(handler); return () => this.pushHandlers.delete(handler) }
  onSessionEvent(handler: KakaoSessionEventHandler) { this.sessionHandlers.add(handler); return () => this.sessionHandlers.delete(handler) }
  emitWire(method: string, body: Record<string, unknown>) {
    const bytes = encodePacket({ packetId: 0, statusCode: 0, method, bodyType: LOCO_BODY_TYPE_BSON, body })
    const packet = decodePacket(bytes)!.packet
    for (const handler of this.pushHandlers) handler(packet)
  }
}

describe('decodeReactionPush', () => {
  it('keeps 64-bit chat, log and revision ids digit for digit and sorts kinds', () => {
    expect(decodeReactionPush(wire(legacy()))).toEqual({
      type: 'CHGLOGMETA', chat_id: BIG, log_id: BIG_MINUS_ONE, link_id: null,
      revision: '9007199254740993', reactions: [{ kind: 1, count: 1 }, { kind: 3, count: 2 }],
    })
  })

  it('reads small ids delivered as numbers and an open chat link id', () => {
    const event = decodeReactionPush(wire(legacy({ chatId: 11, logId: 12, revision: 13, linkId: Long.fromString('8000000000000000001') })))
    expect(event).toMatchObject({ chat_id: '11', log_id: '12', revision: '13', link_id: '8000000000000000001' })
  })

  it('treats an absent, null or zero link id as a direct chat', () => {
    for (const linkId of [undefined, null, 0, Long.fromNumber(0)]) {
      const body = legacy(linkId === undefined ? {} : { linkId })
      const event = decodeReactionPush(wire(body))
      expect(event).not.toBeNull()
      expect(event!.link_id).toBeNull()
    }
  })

  it('reports a known empty aggregate after the last cancellation', () => {
    expect(decodeReactionPush(wire(legacy({ content: '{}' })))?.reactions).toEqual([])
  })

  it('keeps a zero count of a kind as given', () => {
    expect(decodeReactionPush(wire(legacy({ content: '{"2":0,"6":4}' })))?.reactions).toEqual([{ kind: 2, count: 0 }, { kind: 6, count: 4 }])
  })

  it('does not type a mini/custom (type 2) aggregate', () => {
    const body = legacy({ type: 2, content: '{"rx":[{"a":{"ko":"사랑"},"c":1,"k":2,"o":"1200509_029"}]}' })
    expect(decodeReactionPush(wire(body))).toBeNull()
  })

  const malformed: Array<[string, Record<string, unknown>]> = [
    ['zero chat', { chatId: 0 }],
    ['string chat', { chatId: '11' }],
    ['negative log', { logId: Long.fromNumber(-5) }],
    ['out of range revision', { revision: Long.fromString('18446744073709551615', true) }],
    ['zero revision', { revision: 0 }],
    ['missing revision', { revision: undefined }],
    ['string type', { type: '1' }],
    ['negative link', { linkId: Long.fromNumber(-1) }],
    ['content not a string', { content: { 1: 1 } }],
    ['content not JSON', { content: '{1:1' }],
    ['content an array', { content: '[1]' }],
    ['content null', { content: 'null' }],
    ['unknown kind 7', { content: '{"7":1}' }],
    ['kind 0', { content: '{"0":1}' }],
    ['negative count', { content: '{"1":-1}' }],
    ['fractional count', { content: '{"1":1.5}' }],
    ['unsafe count', { content: '{"1":9007199254740993}' }],
    ['string count', { content: '{"1":"1"}' }],
  ]
  for (const [name, overrides] of malformed) {
    it(`types nothing for ${name}`, () => {
      const body = legacy(overrides)
      for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key]
      expect(decodeReactionPush(wire(body))).toBeNull()
    })
  }
})

describe('KakaoTalkListener reaction', () => {
  it('emits one typed reaction and the unchanged generic CHGLOGMETA', async () => {
    const client = new FakeClient()
    const listener = new KakaoTalkListener(client as unknown as KakaoTalkClient)
    const reactions: KakaoTalkPushReactionEvent[] = []
    const generic: KakaoTalkPushGenericEvent[] = []
    const messages: unknown[] = []
    const reads: unknown[] = []
    listener.on('reaction', (event) => reactions.push(event))
    listener.on('kakaotalk_event', (event) => generic.push(event))
    listener.on('message', (event) => messages.push(event))
    listener.on('read', (event) => reads.push(event))
    await listener.start()
    client.emitWire('CHGLOGMETA', legacy())
    client.emitWire('CHGLOGMETA', legacy({ type: 2, content: '{"rx":[]}' }))
    client.emitWire('CHGLOGMETA', legacy({ content: 'broken' }))
    expect(reactions.map((event) => [event.chat_id, event.log_id, event.revision])).toEqual([[BIG, BIG_MINUS_ONE, '9007199254740993']])
    expect(generic.map((event) => [event.type, event.payload_type])).toEqual([['CHGLOGMETA', 1], ['CHGLOGMETA', 2], ['CHGLOGMETA', 1]])
    expect(messages).toEqual([])
    expect(reads).toEqual([])
    listener.stop()
  })
})

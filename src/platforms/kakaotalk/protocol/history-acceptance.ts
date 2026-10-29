import { Long } from 'bson'
import type { LocoPacket } from './types'

const exactId = (value: unknown): string => {
  const text = typeof value === 'string' ? value : Long.isLong(value) ? value.toString() : ''
  if (!/^(0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text) > 9223372036854775807n) {
    throw new Error('HISTORY_ACCEPTANCE_SCOPE_REJECTED')
  }
  return text
}

/** A finite, opt-in history acceptance budget; never used by ordinary clients. */
export class HistoryAcceptanceGuard {
  readonly signal: AbortSignal
  private abort = new AbortController()
  private timer: ReturnType<typeof setTimeout>
  private stage: 'startup' | 'before' | 'history' | 'after' | 'closed' = 'startup'
  private pending: string | null = null
  private methods: string[] = []
  private sockets = 0
  private blocked = 0
  private providerStatus: number | null = null
  private startup = { GETCONF: 0, CHECKIN: 0, LOGINLIST: 0 }
  private probe = { CHATINFO: 0, MCHATLOGS: 0, SYNCMSG: 0 }
  private failedCode: string | null = null
  private deadline = performance.now() + 60_000
  private readonly room: string
  private readonly from: string
  private readonly target: string

  constructor(target: { roomId: string; fromId: string; targetLatestId: string }) {
    this.room = exactId(target.roomId)
    this.from = exactId(target.fromId)
    this.target = exactId(target.targetLatestId)
    if (this.room === '0' || BigInt(this.from) > BigInt(this.target)) throw new Error('HISTORY_ACCEPTANCE_SCOPE_REJECTED')
    this.signal = this.abort.signal
    this.timer = setTimeout(() => this.fail('DEADLINE'), 60_000)
  }

  fail(code: 'DEADLINE' | 'CONNECTION_LOST' | 'PROVIDER_REJECTED' | 'SCOPE_REJECTED') {
    if (!this.failedCode) {
      this.failedCode = code
      clearTimeout(this.timer)
      this.abort.abort(Object.assign(new Error('HISTORY_ACCEPTANCE_REFUSED'), { code }))
    }
    return this.signal.reason as Error
  }

  assertActive() {
    if (!this.failedCode && performance.now() >= this.deadline) this.fail('DEADLINE')
    if (this.signal.aborted) throw this.signal.reason
    if (this.stage === 'closed') throw this.fail('SCOPE_REJECTED')
  }

  beforeConnect(kind: 'tls' | 'secure') {
    this.assertActive()
    const expected = this.sockets === 0 ? 'tls' : 'secure'
    if (this.stage !== 'startup' || this.sockets >= 3 || kind !== expected || this.pending) {
      this.blocked++; throw this.fail('SCOPE_REJECTED')
    }
    this.sockets++
  }

  begin(stage: 'before' | 'history' | 'after') {
    this.assertActive()
    const valid = stage === 'before' ? this.stage === 'startup' && this.startup.LOGINLIST === 1
      : stage === 'history' ? this.stage === 'before' && this.probe.CHATINFO === 1
        : this.stage === 'history' && this.probe.MCHATLOGS === 1
    if (!valid || this.pending) throw this.fail('SCOPE_REJECTED')
    this.stage = stage
    this.methods = []
  }

  beforeSend(method: string, body: Record<string, unknown>) {
    this.assertActive()
    try {
      if (this.pending) throw new Error()
      if (this.stage === 'startup') {
        const order = ['GETCONF', 'CHECKIN', 'LOGINLIST'] as const
        const index = this.startup.GETCONF + this.startup.CHECKIN + this.startup.LOGINLIST
        if (order[index] !== method || this.sockets !== index + 1) throw new Error()
        this.startup[method as keyof typeof this.startup]++
      } else {
        const expected = this.stage === 'history' ? ['MCHATLOGS', 'CHATINFO', 'SYNCMSG'][this.methods.length]
          : this.methods.length === 0 && (this.stage === 'before' || this.stage === 'after') ? 'CHATINFO' : null
        if (method !== expected) throw new Error()
        const keys = method === 'MCHATLOGS' ? ['chatIds', 'sinces'] : method === 'SYNCMSG' ? ['chatId','cnt','cur','max'] : ['chatId']
        if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) throw new Error()
        if (method === 'MCHATLOGS') {
          if (!Array.isArray(body.chatIds) || body.chatIds.length !== 1 || exactId(body.chatIds[0]) !== this.room ||
              !Array.isArray(body.sinces) || body.sinces.length !== 1 || exactId(body.sinces[0]) !== this.from) throw new Error()
        } else if (exactId(body.chatId) !== this.room) throw new Error()
        if (method === 'SYNCMSG' && (body.cnt !== 0 || exactId(body.cur) !== this.from || exactId(body.max) !== this.target)) throw new Error()
        if (this.probe.CHATINFO + this.probe.MCHATLOGS + this.probe.SYNCMSG >= 5) throw new Error()
        this.probe[method as keyof typeof this.probe]++
        this.methods.push(method)
      }
      this.pending = method
    } catch {
      this.blocked++; throw this.fail('SCOPE_REJECTED')
    }
  }

  response(method: string, packet: LocoPacket) {
    this.assertActive()
    if (this.pending !== method) throw this.fail('SCOPE_REJECTED')
    this.pending = null
    const status = packet.statusCode === 0 ? packet.body.status ?? 0 : packet.statusCode
    if (!Number.isSafeInteger(status) || (status as number) < -2147483648 || (status as number) > 2147483647) {
      throw this.fail('SCOPE_REJECTED')
    }
    if (status !== 0) {
      this.providerStatus = status as number
      throw this.fail('PROVIDER_REJECTED')
    }
    if (method === 'LOGINLIST') {
      this.deadline = performance.now() + 15_000
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.fail('DEADLINE'), 15_000)
    }
  }

  get observation() {
    return { code: this.failedCode, providerStatus: this.providerStatus,
      counters: { startup: { ...this.startup }, probe: { ...this.probe }, sockets: this.sockets,
        connectionAttempts: this.startup.GETCONF > 0 ? 1 : 0, blocked: this.blocked } }
  }

  close() { clearTimeout(this.timer); this.stage = 'closed' }
}

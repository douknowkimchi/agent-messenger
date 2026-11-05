import { afterAll, afterEach, beforeEach, describe, expect, mock, it } from 'bun:test'
import * as originalFs from 'node:fs'
import * as originalPromises from 'node:fs/promises'

import { KakaoTalkClient, KakaoTalkListener, KakaoTalkError, type KakaoConnectionAdmission, type KakaoConnectionAdmissionContext, type KakaoSessionEvent } from './index'
import { KakaoLoginResponseError } from './protocol/login-response'
import type { LocoPacket } from './protocol/types'
import type { KakaoTalkPushMessageEvent } from './types'

// All config I/O is an in-memory external seam, including the original no-hook cases.
// No credential manager, real network, or user's config directory is accessed.
const diskFs = { ...originalFs }
const diskPromises = { ...originalPromises }
const memoryRoot = 'Z:/SER5_SDK_ADMISSION_SYNTHETIC_ONLY'
const priorConfigDir = process.env.AGENT_MESSENGER_CONFIG_DIR
process.env.AGENT_MESSENGER_CONFIG_DIR = memoryRoot
const memoryFiles = new Map<string, string>()
let fsEffects = 0
function memoryPath(path: unknown): string {
  const normalized = String(path).replaceAll('\\', '/')
  if (!normalized.startsWith(memoryRoot + '/')) throw new Error('Unexpected synthetic file path')
  fsEffects++
  return normalized
}
mock.module('node:fs', () => ({ ...diskFs, existsSync: (path: unknown) => memoryFiles.has(memoryPath(path)) }))
mock.module('node:fs/promises', () => ({ ...diskPromises,
  mkdir: async (path: unknown) => { if (String(path).replaceAll('\\', '/') !== memoryRoot) memoryPath(path); else fsEffects++ },
  chmod: async (path: unknown) => { memoryPath(path) },
  readFile: async (path: unknown) => {
    const value = memoryFiles.get(memoryPath(path))
    if (value === undefined) throw Object.assign(new Error('Synthetic missing file'), { code: 'ENOENT' })
    return value
  },
  writeFile: async (path: unknown, data: unknown) => { memoryFiles.set(memoryPath(path), String(data)) },
}))
afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.AGENT_MESSENGER_CONFIG_DIR
  else process.env.AGENT_MESSENGER_CONFIG_DIR = priorConfigDir
  mock.module('node:fs', () => diskFs)
  mock.module('node:fs/promises', () => diskPromises)
})
beforeEach(() => { memoryFiles.clear(); fsEffects = 0 })
afterEach(() => { for (const session of sessions) session.close() })
let loginFailure: Error | undefined

const sessions: MockLocoSession[] = []
const loginCalls: Array<{
  oauthToken: string
  userId: string
  deviceUuid: string
  syncState: unknown
  deviceType: string
}> = []

class MockLocoSession {
  pushHandler: ((packet: LocoPacket) => void) | null = null
  closeHandler: (() => void) | null = null
  closed = false
  loginResult: Record<string, unknown> = {
    chatDatas: [],
    lastTokenId: { low: 0, high: 0 },
    lastChatId: { low: 0, high: 0 },
    eof: true,
  }

  loginImpl: (
    oauthToken: string,
    userId: string,
    deviceUuid: string,
    syncState: unknown,
    deviceType: string,
  ) => Promise<unknown> = async (oauthToken, userId, deviceUuid, syncState, deviceType) => {
    loginCalls.push({ oauthToken, userId, deviceUuid, syncState, deviceType })
    if (loginFailure) throw loginFailure
    return this.loginResult
  }

  sendMessageImpl: (chatId: unknown, text: string) => Promise<unknown> = async () => ({
    statusCode: 0,
    body: { logId: { low: 1, high: 0 }, sendAt: 1 },
  })

  getChatLogsImpl: () => Promise<unknown> = async () => ({
    body: { status: 0, chatLogs: [], eof: true },
  })

  constructor() {
    sessions.push(this)
  }

  login(
    oauthToken: string,
    userId: string,
    deviceUuid: string,
    syncState: unknown,
    deviceType: string,
  ): Promise<unknown> {
    return this.loginImpl(oauthToken, userId, deviceUuid, syncState, deviceType)
  }

  sendMessage(chatId: unknown, text: string): Promise<unknown> {
    return this.sendMessageImpl(chatId, text)
  }

  getChatLogs(): Promise<unknown> {
    return this.getChatLogsImpl()
  }

  getChatList(): Promise<unknown> {
    return Promise.resolve({ body: { chatDatas: [], lastTokenId: { low: 0, high: 0 }, eof: true } })
  }

  getChatInfo(): Promise<unknown> {
    return Promise.resolve({ body: { l: { low: 0, high: 0 } } })
  }

  syncMessages(): Promise<unknown> {
    return Promise.resolve({ body: { chatLogs: [], isOK: true } })
  }

  onPush(handler: (packet: LocoPacket) => void): void {
    this.pushHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.closeHandler?.()
  }

  simulatePush(method: string, body: Record<string, unknown> = {}): void {
    this.pushHandler?.({ packetId: 0, statusCode: 0, method, bodyType: 0, body })
  }

  simulateRemoteClose(): void {
    if (this.closed) return
    this.closed = true
    this.closeHandler?.()
  }
}

mock.module('./protocol/session', () => ({ LocoSession: MockLocoSession }))

const CREDS = {
  oauthToken: 'tok',
  userId: 'user1',
  deviceUuid: 'device-uuid-1',
  deviceType: 'tablet' as const,
}

function currentSession(): MockLocoSession {
  return sessions[sessions.length - 1]!
}

describe('KakaoTalkClient + KakaoTalkListener integration (shared LOCO session)', () => {
  beforeEach(() => {
    sessions.length = 0
    loginCalls.length = 0
  })

  afterEach(() => {
    sessions.length = 0
    loginCalls.length = 0
  })

  it('opens exactly ONE LocoSession when a client and listener are used together', async () => {
    // given — a client logged in and a listener attached
    const client = await new KakaoTalkClient().login(CREDS)
    const listener = new KakaoTalkListener(client)

    // when — listener starts AND client makes API calls
    await listener.start()
    await client.sendMessage('100', 'hi')
    await client.getChats()

    // then — only one LocoSession was constructed; only one LOGINLIST sent
    expect(sessions.length).toBe(1)
    expect(loginCalls.length).toBe(1)
    expect(loginCalls[0].deviceUuid).toBe(CREDS.deviceUuid)

    listener.stop()
    client.close()
  })

  it('never sends a duplicate LOGINLIST with the same duuid while a session is alive', async () => {
    // given — a strict guard: any second login while the first session is still open is a self-KICKOUT.
    const client = await new KakaoTalkClient().login(CREDS)
    const listener = new KakaoTalkListener(client)
    await listener.start()

    // when — heavy interleaving of outbound calls and inbound pushes
    for (let i = 0; i < 10; i++) {
      await client.sendMessage(String(100 + i), `msg-${i}`)
      currentSession().simulatePush('MSG', {
        chatId: { low: 100 + i, high: 0 },
        chatLog: { logId: { low: i, high: 0 }, authorId: 1, message: `pushed-${i}`, type: 1, sendAt: i },
      })
    }

    // then — still exactly one LOGINLIST, never a second one against the live session
    const liveSessions = sessions.filter((s) => !s.closed)
    expect(liveSessions.length).toBe(1)
    expect(loginCalls.length).toBe(1)

    listener.stop()
    client.close()
  })

  it('listener still receives push events when only the listener is used (no API calls)', async () => {
    const client = await new KakaoTalkClient().login(CREDS)
    const listener = new KakaoTalkListener(client)

    const messages: KakaoTalkPushMessageEvent[] = []
    listener.on('message', (event) => messages.push(event))

    await listener.start()
    expect(sessions.length).toBe(1)

    currentSession().simulatePush('MSG', {
      chatId: { low: 100, high: 0 },
      chatLog: {
        logId: { low: 1, high: 0 },
        authorId: 42,
        message: 'hello',
        type: 1,
        sendAt: 1700000000,
      },
    })

    expect(messages.length).toBe(1)
    expect(messages[0].chat_id).toBe('100')
    expect(messages[0].message).toBe('hello')

    listener.stop()
    client.close()
  })

  it('client-only usage still works (no listener)', async () => {
    const client = await new KakaoTalkClient().login(CREDS)
    const result = await client.sendMessage('100', 'hi')

    expect(result.success).toBe(true)
    expect(sessions.length).toBe(1)

    client.close()
  })

  it('real KICKOUT propagates to listener and closes the session', async () => {
    // given — client + listener sharing a session
    const client = await new KakaoTalkClient().login(CREDS)
    const listener = new KakaoTalkListener(client)

    const errors: Error[] = []
    listener.on('error', (err) => errors.push(err))

    await listener.start()
    expect(sessions.length).toBe(1)
    const sharedSession = currentSession()

    // when — server pushes a KICKOUT (a different real device logged in)
    sharedSession.simulatePush('KICKOUT', {})

    // then — listener emits the canonical error and stops itself
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain('kicked')
    expect((listener as unknown as { running: boolean }).running).toBe(false)

    listener.stop()
    client.close()
  })

  it('reconnect after a TCP-level disconnect produces ONE replacement session shared by both halves', async () => {
    // given — listener + client on a shared session
    const client = await new KakaoTalkClient().login(CREDS)
    const listener = new KakaoTalkListener(client)

    const disconnects: number[] = []
    const connects: Array<{ userId: string }> = []
    listener.on('disconnected', () => disconnects.push(Date.now()))
    listener.on('connected', (info) => connects.push(info))

    await listener.start()
    expect(sessions.length).toBe(1)
    expect(connects.length).toBe(1)

    // when — the underlying socket dies (not a KICKOUT)
    currentSession().simulateRemoteClose()

    // then — listener observed the disconnect
    expect(disconnects.length).toBe(1)

    // and — the next API call transparently opens exactly ONE replacement session
    await client.sendMessage('100', 'after-reconnect')

    expect(sessions.length).toBe(2)
    // and — the listener was re-attached to that replacement session (i.e. push fan-out works again)
    const messages: KakaoTalkPushMessageEvent[] = []
    listener.on('message', (event) => messages.push(event))
    currentSession().simulatePush('MSG', {
      chatId: { low: 100, high: 0 },
      chatLog: { logId: { low: 9, high: 0 }, authorId: 1, message: 'after-reconnect-push', type: 1, sendAt: 1 },
    })
    expect(messages.length).toBe(1)
    expect(connects.length).toBe(2)

    listener.stop()
    client.close()
  })

  it('CHANGESVR triggers an active session migration', async () => {
    // given — a listener attached to a shared session
    const client = await new KakaoTalkClient().login(CREDS)
    const listener = new KakaoTalkListener(client)

    const disconnects: number[] = []
    const connects: Array<{ userId: string }> = []
    const generic: Array<{ type: string }> = []
    listener.on('disconnected', () => disconnects.push(1))
    listener.on('connected', (info) => connects.push(info))
    listener.on('kakaotalk_event', (event) => generic.push(event))

    await listener.start()
    expect(sessions.length).toBe(1)
    expect(connects.length).toBe(1)

    // when — the server pushes CHANGESVR (asking us to migrate to a new gateway)
    sessions[0]!.simulatePush('CHANGESVR', {})

    // then — the client actively migrates: old session closed, new one opened
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.length).toBe(2)
    expect(sessions[0]!.closed).toBe(true)
    expect(disconnects.length).toBe(1)
    expect(connects.length).toBe(2)

    // and — the listener re-attached to the replacement session for push events
    const messages: KakaoTalkPushMessageEvent[] = []
    listener.on('message', (event) => messages.push(event))
    sessions[1]!.simulatePush('MSG', {
      chatId: { low: 100, high: 0 },
      chatLog: { logId: { low: 7, high: 0 }, authorId: 1, message: 'after-changesvr', type: 1, sendAt: 1 },
    })
    expect(messages.length).toBe(1)

    // and — CHANGESVR was still surfaced as a generic event for observers that care
    expect(generic.some((e) => e.type === 'CHANGESVR')).toBe(true)

    listener.stop()
    client.close()
  })

  it('does not open duplicate LOGINLIST when concurrent calls trigger executeWithReconnect retry', async () => {
    // given — a client+listener with a slow LOGINLIST so concurrent reconnects can collide
    let inflight = 0
    let peakInflight = 0
    const originalLogin = MockLocoSession.prototype.login
    MockLocoSession.prototype.login = async function (oauthToken, userId, deviceUuid, syncState, deviceType) {
      inflight++
      peakInflight = Math.max(peakInflight, inflight)
      try {
        await new Promise((r) => setTimeout(r, 20))
        return await originalLogin.call(this, oauthToken, userId, deviceUuid, syncState, deviceType)
      } finally {
        inflight--
      }
    }

    try {
      const client = await new KakaoTalkClient().login(CREDS)
      await client.sendMessage('100', 'prime')
      expect(sessions.length).toBe(1)
      expect(loginCalls.length).toBe(1)

      // Make the live session's sendMessage drop the socket and then throw — modeling a
      // mid-flight TCP reset where the remote-close handler nulls this.state synchronously
      // before the operation rejection bubbles up to executeWithReconnect's catch block.
      // This is the precise window the executeWithReconnect retry path was designed for.
      const dead = sessions[0]!
      dead.sendMessageImpl = async function () {
        dead.simulateRemoteClose()
        throw new Error('socket closed')
      }

      // when — three concurrent sendMessage calls all hit the dead session and retry
      await Promise.all([
        client.sendMessage('100', 'a'),
        client.sendMessage('100', 'b'),
        client.sendMessage('100', 'c'),
      ])

      // then — exactly ONE replacement LOGINLIST regardless of retry collisions
      expect(peakInflight).toBe(1)
      expect(loginCalls.length).toBe(2)
      expect(sessions.length).toBe(2)

      client.close()
    } finally {
      MockLocoSession.prototype.login = originalLogin
    }
  })

  it('drops pushes from a session that has not been adopted as the active state', async () => {
    // given — a listener subscribed to push events, before any session is opened
    const client = await new KakaoTalkClient().login(CREDS)
    const listener = new KakaoTalkListener(client)
    const messages: KakaoTalkPushMessageEvent[] = []
    listener.on('message', (event) => messages.push(event))

    // Slow down login so we can fire a push DURING the connect()/login window,
    // when LocoSession has been constructed but this.state is still null.
    let preAdoptionPushFired = false
    const originalLogin = MockLocoSession.prototype.login
    MockLocoSession.prototype.login = async function (oauthToken, userId, deviceUuid, syncState, deviceType) {
      if (!preAdoptionPushFired) {
        preAdoptionPushFired = true
        this.simulatePush('MSG', {
          chatId: { low: 1, high: 0 },
          chatLog: { logId: { low: 1, high: 0 }, authorId: 1, message: 'too-early', type: 1, sendAt: 1 },
        })
      }
      return originalLogin.call(this, oauthToken, userId, deviceUuid, syncState, deviceType)
    }

    try {
      // when — start the listener, which triggers connect() and a pre-adoption push
      await listener.start()
      expect(preAdoptionPushFired).toBe(true)

      // then — the pre-adoption push must NOT have leaked to subscribers
      expect(messages.length).toBe(0)

      // and — once the session is adopted, fresh pushes flow normally
      sessions[0]!.simulatePush('MSG', {
        chatId: { low: 1, high: 0 },
        chatLog: { logId: { low: 2, high: 0 }, authorId: 1, message: 'fresh', type: 1, sendAt: 2 },
      })
      expect(messages.length).toBe(1)
      expect(messages[0].message).toBe('fresh')

      listener.stop()
      client.close()
    } finally {
      MockLocoSession.prototype.login = originalLogin
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const ownedClients: KakaoTalkClient[] = []
const ownedListeners: KakaoTalkListener[] = []
async function admittedClient(admission: KakaoConnectionAdmission) {
  const client = new KakaoTalkClient({ connectionAdmission: admission })
  ownedClients.push(client)
  await client.login(CREDS)
  return client
}
function attachedListener(client: KakaoTalkClient) {
  const listener = new KakaoTalkListener(client)
  ownedListeners.push(listener)
  return listener
}
function safeAdmissionError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(KakaoTalkError)
  const typed = error as KakaoTalkError
  expect(typed.code).toBe(code)
  expect(typed.cause).toBeUndefined()
  expect(typed.serverStatus).toBeUndefined()
  expect(typed.message).toBe('Connection admission blocked')
  expect(String(typed.stack) + JSON.stringify(typed)).not.toContain('PRIVATE_ADMISSION_SENTINEL')
}

describe('SDK_ADMISSION', () => {
  beforeEach(() => { sessions.length = 0; loginCalls.length = 0; loginFailure = undefined })
  afterEach(() => {
    for (const listener of ownedListeners.splice(0)) listener.stop()
    for (const client of ownedClients.splice(0)) client.close()
    loginFailure = undefined
  })

  it('A02 reserves once for concurrent public listener/acquire/API, not login or live reuse', async () => {
    const contexts: KakaoConnectionAdmissionContext[] = []
    const client = await admittedClient(context => { contexts.push(context); return true })
    expect(contexts.length).toBe(0)
    expect(sessions.length).toBe(0)
    expect(fsEffects).toBe(0)
    const listener = attachedListener(client)
    await Promise.all([listener.start(), client.acquireSession(), client.getChats()])
    expect(contexts.length).toBe(1)
    expect(contexts[0].attemptSequence).toBe(1)
    expect(Object.keys(contexts[0]).sort()).toEqual(['attemptSequence', 'signal'])
    expect(Object.isFrozen(contexts[0])).toBe(true)
    expect(sessions.length).toBe(1)
    expect(loginCalls.length).toBe(1)
    await Promise.all([client.getChats(), client.acquireSession()])
    expect(contexts.length).toBe(1)
  })

  for (const [label, value] of [['false', false], ['undefined', undefined], ['null', null], ['zero', 0], ['string', 'true'], ['object', {}]] as const) {
    it(`A03 non-true ${label} denies before all session and sync I/O and latches`, async () => {
      let calls = 0
      const client = await admittedClient(() => { calls++; return value as unknown as boolean })
      const events: KakaoSessionEvent[] = []
      client.onSessionEvent(event => events.push(event))
      const results = await Promise.allSettled([client.acquireSession(), client.getChats(), client.acquireSession()])
      for (const result of results) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') safeAdmissionError(result.reason, 'connection_admission_denied')
      }
      await expect(client.getChats()).rejects.toMatchObject({ code: 'connection_admission_denied' })
      expect(events).toEqual([{ type: 'connection_blocked', code: 'connection_admission_denied' }])
      expect(calls).toBe(1)
      expect(sessions.length).toBe(0)
      expect(loginCalls.length).toBe(0)
      expect(fsEffects).toBe(0)
    })
  }

  for (const asynchronous of [false, true]) {
    it(`A04 callback ${asynchronous ? 'reject' : 'throw'} is a safe latched failure`, async () => {
      let calls = 0
      const secret = Object.assign(new Error('PRIVATE_ADMISSION_SENTINEL'), { body: 'PRIVATE_ADMISSION_SENTINEL', cause: new Error('PRIVATE_ADMISSION_SENTINEL') })
      const client = await admittedClient(() => { calls++; if (asynchronous) return Promise.reject(secret); throw secret })
      const events: KakaoSessionEvent[] = []
      client.onSessionEvent(event => events.push(event))
      for (let i = 0; i < 2; i++) {
        const [result] = await Promise.allSettled([client.acquireSession()])
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') safeAdmissionError(result.reason, 'connection_admission_failed')
      }
      expect(calls).toBe(1)
      expect(events).toEqual([{ type: 'connection_blocked', code: 'connection_admission_failed' }])
      expect(sessions.length).toBe(0)
      expect(fsEffects).toBe(0)
    })
  }

  it('A04 invalid runtime callback/options fail without effects or raw cause', () => {
    for (const options of [null, [], false, { connectionAdmission: 4 }, { get connectionAdmission() { throw new Error('PRIVATE_ADMISSION_SENTINEL') } }]) {
      let error: unknown
      try { new KakaoTalkClient(options as never) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(KakaoTalkError)
      expect((error as KakaoTalkError).code).toBe('connection_admission_failed')
      expect((error as Error).cause).toBeUndefined()
      expect(String(error)).not.toContain('PRIVATE_ADMISSION_SENTINEL')
    }
    expect(sessions.length).toBe(0)
    expect(fsEffects).toBe(0)
  })

  it('A05 delayed admission publishes single-flight before synchronous nonawaited reentry', async () => {
    const gate = deferred<boolean>()
    let calls = 0, nested: Promise<unknown> | undefined
    let client!: KakaoTalkClient
    client = await admittedClient(() => { calls++; nested = client.acquireSession(); return gate.promise })
    const results = Promise.all([client.acquireSession(), client.getChats(), attachedListener(client).start()])
    await settle()
    expect(calls).toBe(1)
    expect(nested).toBeDefined()
    expect(sessions.length).toBe(0)
    expect(fsEffects).toBe(0)
    gate.resolve(true)
    await results
    await nested
    expect(sessions.length).toBe(1)
    expect(loginCalls.length).toBe(1)
    expect(calls).toBe(1)
  })

  for (const change of [{ oauthToken: 'different-synthetic' }, { userId: 'different-user' }, { deviceUuid: 'different-device' }, { deviceType: 'pc' as const }]) {
    it(`A06 changed ${Object.keys(change)[0]} while waiting cannot use the prior permit`, async () => {
      const gate = deferred<boolean>()
      const client = await admittedClient(() => gate.promise)
      const result = Promise.allSettled([client.acquireSession()])
      await settle()
      await client.login({ ...CREDS, ...change })
      gate.resolve(true)
      const [finished] = await result
      expect(finished.status).toBe('rejected')
      if (finished.status === 'rejected') safeAdmissionError(finished.reason, 'connection_admission_failed')
      expect(sessions.length).toBe(0)
      expect(fsEffects).toBe(0)
    })
  }

  it('A07 CHANGESVR denial is observed once and stops the listener without a second session', async () => {
    const sequences: number[] = []
    const client = await admittedClient(({ attemptSequence }) => { sequences.push(attemptSequence); return attemptSequence === 1 })
    const listener = attachedListener(client)
    const errors: Error[] = [], events: KakaoSessionEvent[] = []
    listener.on('error', error => errors.push(error))
    client.onSessionEvent(event => events.push(event))
    await listener.start()
    const beforeEffects = fsEffects
    currentSession().simulatePush('CHANGESVR')
    await settle()
    expect(sequences).toEqual([1, 2])
    expect(sessions.length).toBe(1)
    expect(loginCalls.length).toBe(1)
    expect(fsEffects).toBe(beforeEffects)
    expect(events.filter(event => event.type === 'connected').length).toBe(1)
    expect(events.filter(event => event.type === 'connection_blocked')).toEqual([{ type: 'connection_blocked', code: 'connection_admission_denied' }])
    expect(errors.length).toBe(1)
    safeAdmissionError(errors[0], 'connection_admission_denied')
    expect((listener as unknown as { running: boolean }).running).toBe(false)
    expect((client as unknown as { pushHandlers: Set<unknown> }).pushHandlers.size).toBe(0)
    expect((client as unknown as { sessionEventHandlers: Set<unknown> }).sessionEventHandlers.size).toBe(1)
    await expect(client.getChats()).rejects.toMatchObject({ code: 'connection_admission_denied' })
    expect(sequences).toEqual([1, 2])
  })

  for (const allowed of [true, false]) {
    it(`A08 concurrent dead-session API retry and acquisition share ${allowed ? 'allowed' : 'denied'} replacement`, async () => {
      const gate = deferred<boolean>()
      let admissions = 0
      const client = await admittedClient(() => ++admissions === 1 ? true : gate.promise)
      await client.acquireSession()
      const dead = currentSession()
      dead.sendMessageImpl = async () => { dead.simulateRemoteClose(); throw new Error('Synthetic socket close') }
      const api = Promise.allSettled([client.sendMessage('100', 'a'), client.sendMessage('100', 'b'), client.sendMessage('100', 'c')])
      await settle()
      const health = Promise.allSettled([client.acquireSession()])
      expect(admissions).toBe(2)
      expect(sessions.length).toBe(1)
      gate.resolve(allowed)
      const results = [...await api, ...await health]
      for (const result of results) {
        expect(result.status).toBe(allowed ? 'fulfilled' : 'rejected')
        if (result.status === 'rejected') expect(result.reason.code).toBe('connection_admission_denied')
      }
      expect(sessions.length).toBe(allowed ? 2 : 1)
      expect(loginCalls.length).toBe(allowed ? 2 : 1)
      expect(admissions).toBe(2)
    })
  }

  it('A09 two clients share an external synthetic reservation rather than client-local budget', async () => {
    let remaining = 1, calls = 0
    const reserve = () => { calls++; return remaining-- > 0 }
    const first = await admittedClient(reserve)
    await first.acquireSession()
    first.close()
    const second = await admittedClient(reserve)
    await expect(second.acquireSession()).rejects.toMatchObject({ code: 'connection_admission_denied' })
    await expect(second.getChats()).rejects.toMatchObject({ code: 'connection_admission_denied' })
    expect(calls).toBe(2)
    expect(sessions.length).toBe(1)
    expect(loginCalls.length).toBe(1)
  })

  for (const completion of ['late_true', 'late_reject', 'never_settle']) {
    it(`A10 close cancels ${completion} admission without effects or unhandled rejection`, async () => {
      const gate = deferred<boolean>()
      let context: KakaoConnectionAdmissionContext | undefined
      const client = await admittedClient(value => { context = value; return gate.promise })
      const listener = attachedListener(client)
      const errors: Error[] = []
      listener.on('error', error => errors.push(error))
      const failures: unknown[] = []
      const onUnhandled = (error: unknown) => { failures.push(error) }
      process.on('unhandledRejection', onUnhandled)
      try {
        const result = Promise.allSettled([client.acquireSession(), client.getChats()])
        const starting = listener.start()
        await settle()
        expect(context).toBeDefined()
        listener.stop()
        client.close()
        for (const item of await result) {
          expect(item.status).toBe('rejected')
          if (item.status === 'rejected') expect(item.reason.code).toBe('client_closed')
        }
        await starting
        expect(context!.signal.aborted).toBe(true)
        if (completion === 'late_true') gate.resolve(true)
        if (completion === 'late_reject') gate.reject(new Error('PRIVATE_ADMISSION_SENTINEL'))
        await settle()
        expect(errors).toEqual([])
        expect(failures).toEqual([])
        expect(sessions.length).toBe(0)
        expect(loginCalls.length).toBe(0)
        expect(fsEffects).toBe(0)
        expect(client.isConnected()).toBe(false)
        await expect(client.acquireSession()).rejects.toMatchObject({ code: 'client_closed' })
      } finally { process.off('unhandledRejection', onUnhandled); client.close() }
    })
  }

  it('A10 listener stop suppresses late denial and still does not close the client', async () => {
    for (const allowed of [false, true]) {
      const gate = deferred<boolean>()
      const client = await admittedClient(() => gate.promise)
      const listener = attachedListener(client)
      const errors: Error[] = []
      listener.on('error', error => errors.push(error))
      const started = listener.start()
      await settle()
      listener.stop()
      gate.resolve(allowed)
      await started
      expect(errors).toEqual([])
      expect(client.isConnected()).toBe(allowed)
      client.close()
    }
  })

  for (const throwingSubscriber of [false, true]) {
    it(`A11 blocked event/start catch emit once and tear down before ${throwingSubscriber ? 'throwing' : 'normal'} subscriber`, async () => {
      const client = await admittedClient(() => false)
      const listener = attachedListener(client)
      const errors: Error[] = []
      const snapshots: Array<{ running: boolean; push: number; session: number }> = []
      listener.on('error', error => {
        errors.push(error)
        snapshots.push({
          running: (listener as unknown as { running: boolean }).running,
          push: (client as unknown as { pushHandlers: Set<unknown> }).pushHandlers.size,
          session: (client as unknown as { sessionEventHandlers: Set<unknown> }).sessionEventHandlers.size,
        })
        if (throwingSubscriber) throw new Error('Synthetic subscriber throw')
      })
      const direct = Promise.allSettled([client.acquireSession()])
      await listener.start()
      const [result] = await direct
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') safeAdmissionError(result.reason, 'connection_admission_denied')
      expect(errors.length).toBe(1)
      safeAdmissionError(errors[0], 'connection_admission_denied')
      expect(snapshots).toEqual([{ running: false, push: 0, session: 0 }])
      expect(fsEffects).toBe(0)
      expect(sessions.length).toBe(0)
    })
  }

  for (const [code, sourceError] of [
    ['invalid_access_token', new KakaoLoginResponseError('invalid_access_token', -950)],
    ['login_rejected', new KakaoLoginResponseError('login_rejected', -777)],
    ['login_failed', new Error('Synthetic transport failure')],
  ] as const) {
    it(`A12 admitted provider ${code} preserves existing error taxonomy without a latch`, async () => {
      let calls = 0
      const client = await admittedClient(() => { calls++; return true })
      const events: KakaoSessionEvent[] = []
      client.onSessionEvent(event => events.push(event))
      loginFailure = sourceError
      const [result] = await Promise.allSettled([client.acquireSession()])
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason.code).toBe(code)
        expect(result.reason.cause).toBe(sourceError)
        expect(result.reason.serverStatus).toBe(code === 'invalid_access_token' ? -950 : code === 'login_rejected' ? -777 : undefined)
      }
      expect(sessions.length).toBe(1)
      expect(sessions[0].closed).toBe(true)
      expect(events.filter(event => event.type === 'connection_blocked')).toEqual([])
      loginFailure = undefined
      await client.acquireSession()
      expect(calls).toBe(2)
      expect(loginCalls.length).toBe(2)
    })
  }

  it('A13 stale session push cannot spend another pending reservation or resurrect after close', async () => {
    const gate = deferred<boolean>()
    const sequences: number[] = []
    const client = await admittedClient(({ attemptSequence }) => { sequences.push(attemptSequence); return attemptSequence === 1 ? true : gate.promise })
    const listener = attachedListener(client)
    const messages: unknown[] = []
    listener.on('message', message => messages.push(message))
    await listener.start()
    const old = currentSession()
    old.simulateRemoteClose()
    const result = Promise.allSettled([client.acquireSession()])
    await settle()
    old.simulatePush('CHANGESVR')
    old.simulatePush('MSG', { chatId: 1, chatLog: { logId: 1, authorId: 1, message: 'stale', type: 1, sendAt: 1 } })
    expect(sequences).toEqual([1, 2])
    expect(messages).toEqual([])
    expect(sessions.length).toBe(1)
    listener.stop()
    client.close()
    gate.resolve(true)
    const [finished] = await result
    expect(finished.status).toBe('rejected')
    if (finished.status === 'rejected') expect(finished.reason.code).toBe('client_closed')
    await settle()
    expect(sessions.length).toBe(1)
    expect(loginCalls.length).toBe(1)
    expect(client.isConnected()).toBe(false)
  })
})

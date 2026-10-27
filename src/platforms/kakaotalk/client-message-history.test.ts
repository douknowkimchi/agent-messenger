import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Long } from 'bson'
import { KakaoTalkClient } from './client'

const packet = (body: Record<string, unknown> = {}) => ({ statusCode: 0, body: { status: 0, ...body } })
const log = (id: number, chatId = 100) => ({
  chatId, logId: Long.fromNumber(id), type: 1, authorId: 1, message: `synthetic-${id}`, sendAt: id,
})
let chats: unknown[] = []
const mchat = mock(async () => packet({ chatLogs: [], eof: true }))
const info = mock(async () => packet({ chatInfo: { chatId: 100, lastLogId: Long.fromNumber(3) } }))
const sync = mock(async () => packet({ chatLogs: [log(3)], isOK: true }))
const enter = mock(async () => { throw new Error('room entry forbidden') })
const mark = mock(async () => { throw new Error('mark read forbidden') })
const login = mock(async () => ({ chatDatas: chats, eof: true }))
let onClose: (() => void) | undefined
mock.module('./protocol/session', () => ({ LocoSession: class {
  login = login
  getChatLogs = mchat
  getChannelInfo = info
  syncMessages = sync
  enterRoom = enter
  getChatInfo = enter
  markRead = mark
  close() {}
  onPush() {}
  onClose(handler: () => void) { onClose = handler }
} }))

const clients: KakaoTalkClient[] = []
async function client() {
  const value = await new KakaoTalkClient().login({ oauthToken: 'synthetic', userId: '1', deviceUuid: 'history-fixture' })
  clients.push(value)
  return value
}

afterEach(() => {
  clients.splice(0).forEach(value => value.close())
  expect(enter).not.toHaveBeenCalled()
  expect(mark).not.toHaveBeenCalled()
  chats = []
  mchat.mockReset(); info.mockReset(); sync.mockReset(); login.mockClear(); enter.mockClear(); mark.mockClear()
  mchat.mockImplementation(async () => packet({ chatLogs: [], eof: true }))
  info.mockImplementation(async () => packet({ chatInfo: { chatId: 100, lastLogId: Long.fromNumber(3) } }))
  sync.mockImplementation(async () => packet({ chatLogs: [log(3)], isOK: true }))
})

describe('recent history proof', () => {
  for (const failure of [false, true]) {
    it(`recovers absent login watermark after MCHATLOGS ${failure ? 'error' : 'empty'} using CHATINFO`, async () => {
      if (failure) mchat.mockRejectedValueOnce(new Error('synthetic protocol failure'))
      const result = await (await client()).getMessages('100', { count: 2 })
      expect(result.map(value => value.log_id)).toEqual(['3'])
      expect(info).toHaveBeenCalledTimes(1)
      expect(sync.mock.calls[0]?.map(value => String(value))).toEqual(['100', '80', '0', '3'])
      expect(login).toHaveBeenCalledTimes(1)
    })
  }

  it('does not use a stale login watermark as proof that the cursor is current', async () => {
    chats = [{ c: 100, ll: Long.fromNumber(1), l: null }]
    const result = await (await client()).getMessages('100', { from: '1' })
    expect(result.map(value => value.log_id)).toEqual(['3'])
  })

  for (const lastLogId of [Long.ZERO, 0, '0']) {
    it(`proves empty via CHATINFO zero (${typeof lastLogId}) without SYNCMSG`, async () => {
      info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId } }))
      expect(await (await client()).getMessages('100')).toEqual([])
      expect(sync).not.toHaveBeenCalled()
    })
  }

  it('proves a current forward cursor via fresh CHATINFO', async () => {
    expect(await (await client()).getMessages('100', { from: '3' })).toEqual([])
    expect(info).toHaveBeenCalledTimes(1)
    expect(sync).not.toHaveBeenCalled()
  })

  for (const body of [
    { chatInfo: { chatId: 200, lastLogId: Long.ZERO } },
    { chatInfo: { chatId: 100 } },
    { chatInfo: { chatId: 100, lastLogId: -1 } },
    { chatInfo: { chatId: 100, lastLogId: 0, left: true } },
  ]) {
    it(`rejects unavailable or wrong-room CHATINFO: ${JSON.stringify(body)}`, async () => {
      info.mockResolvedValueOnce(packet(body))
      await expect((await client()).getMessages('100')).rejects.toMatchObject({ code: 'get_messages_failed' })
      expect(sync).not.toHaveBeenCalled()
    })
  }

  for (const response of [
    packet({ chatLogs: [], isOK: true }),
    packet({ chatLogs: [log(3, 200)], isOK: true }),
    packet({ chatLogs: [log(1)], isOK: true }),
    { statusCode: -1, body: { error: 'connection closed' } },
    { statusCode: 0, body: { status: -42, chatLogs: [] } },
  ]) {
    it(`rejects missing latest history instead of successful empty/partial: ${JSON.stringify(response)}`, async () => {
      sync.mockResolvedValueOnce(response)
      const failure = await (await client()).getMessages('100').catch(error => error)
      expect(failure.code).toBe('get_messages_failed')
      expect(failure.message).toMatch(/^[a-z_]+$/)
    })
  }

  it('rejects an MCHATLOGS page cap instead of returning an old prefix as recent', async () => {
    let page = 0
    mchat.mockImplementation(async () => packet({ chatLogs: [log(++page)], eof: false }))
    await expect((await client()).getMessages('100', { count: 2 })).rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(mchat).toHaveBeenCalledTimes(50)
    expect(sync).not.toHaveBeenCalled()
  })

  it('exhausts forward MCHATLOGS before slicing recent N, preserving deduplication and order', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(2), log(1)], eof: false }))
      .mockResolvedValueOnce(packet({ chatLogs: [log(2), log(3)], eof: true }))
    const result = await (await client()).getMessages('100', { count: 2 })
    expect(result.map(value => value.log_id)).toEqual(['2', '3'])
    expect(info).not.toHaveBeenCalled()
  })

  it('exhausts bounded SYNCMSG and deduplicates its forward pages before slicing', async () => {
    sync.mockResolvedValueOnce(packet({ chatLogs: [log(2), log(1)], isOK: false }))
      .mockResolvedValueOnce(packet({ chatLogs: [log(2), log(3)], isOK: true }))
    expect((await (await client()).getMessages('100', { count: 2 })).map(value => value.log_id)).toEqual(['2', '3'])
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('rejects stalled SYNCMSG without further pages', async () => {
    sync.mockResolvedValueOnce(packet({ chatLogs: [log(1)], isOK: false }))
      .mockResolvedValueOnce(packet({ chatLogs: [log(1)], isOK: false }))
    await expect((await client()).getMessages('100')).rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('rejects bounded SYNCMSG exhaustion instead of returning an old prefix', async () => {
    info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 1000 } }))
    let page = 0
    sync.mockImplementation(async () => packet({ chatLogs: [log(++page)], isOK: false }))
    await expect((await client()).getMessages('100')).rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(sync).toHaveBeenCalledTimes(50)
  })

  it('retains the existing single replacement when the session closes during history', async () => {
    mchat.mockImplementationOnce(async () => {
      onClose?.()
      throw new Error('synthetic close')
    })
    expect((await (await client()).getMessages('100')).map(value => value.log_id)).toEqual(['3'])
    expect(login).toHaveBeenCalledTimes(2)
  })
})

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
      expect(sync.mock.calls[0]?.map(value => String(value))).toEqual(['100', '0', '0', '3'])
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

  it('does not replay history when the acquired session closes', async () => {
    mchat.mockImplementationOnce(async () => {
      onClose?.()
      throw new Error('synthetic close')
    })
    await expect((await client()).getMessages('100')).rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(login).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })
})


describe('history selection and page truth', () => {
  for (const sameSecond of [true, false]) {
    it(`selects recent N by native log order before truncation (same second=${sameSecond})`, async () => {
      const rows = [log(3), log(1), log(2)].map(value => ({
        ...value, sendAt: sameSecond ? 100 : 100 - Number(value.logId.toString()),
      }))
      mchat.mockResolvedValueOnce(packet({ chatLogs: rows, eof: true }))
      const result = await (await client()).getMessages('100', { count: 2 })
      expect(result.map(value => value.log_id)).toEqual(['2', '3'])
      expect(mchat).toHaveBeenCalledTimes(1)
      expect(sync).not.toHaveBeenCalled()
    })
  }

  it('preserves recent log selection above JavaScript safe integer precision', async () => {
    const ids = ['9007199254740995', '9007199254740993', '9007199254740994']
    mchat.mockResolvedValueOnce(packet({ chatLogs: ids.map(id => ({
      ...log(1), logId: Long.fromString(id), sendAt: 100, message: `synthetic-${id}`,
    })), eof: true }))
    const result = await (await client()).getMessages('100', { count: 2 })
    expect(result.map(value => value.log_id)).toEqual(['9007199254740994', '9007199254740995'])
    expect(result.map(value => value.message)).toEqual(['synthetic-9007199254740994', 'synthetic-9007199254740995'])
  })

  it('selects the same native recent suffix through the SYNCMSG fallback', async () => {
    sync.mockResolvedValueOnce(packet({ chatLogs: [log(3), log(1), log(2)].map(value => ({ ...value, sendAt: 100 })), isOK: true }))
    const result = await (await client()).getMessages('100', { count: 2 })
    expect(result.map(value => value.log_id)).toEqual(['2', '3'])
    expect(mchat).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  for (const rows of [[], [log(2)], [log(1)], [log(3, 200)]]) {
    it(`rejects a terminal page before the fresh watermark (${rows.map(value => String(value.logId)).join(',') || 'empty'}, room=${rows[0]?.chatId ?? 'none'})`, async () => {
      sync.mockResolvedValueOnce(packet({ chatLogs: rows, isOK: true }))
      await expect((await client()).getMessagePage('100', { from: '1', count: 2 }))
        .rejects.toMatchObject({ code: 'get_message_page_failed' })
      expect(mchat).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledTimes(1)
      expect(sync).toHaveBeenCalledTimes(1)
      expect(login).toHaveBeenCalledTimes(1)
    })
  }

  for (const lastLogId of [Long.ZERO, 0, '0']) {
    it(`proves an empty forward page from a validated zero (${typeof lastLogId})`, async () => {
      info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId } }))
      expect(await (await client()).getMessagePage('100'))
        .toEqual({ messages: [], next_cursor: null, complete: true })
      expect(sync).not.toHaveBeenCalled()
    })
  }

  for (const lastLogId of [3, '3']) {
    it(`uses the existing exact watermark reader for a nonzero ${typeof lastLogId}`, async () => {
      info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId } }))
      const page = await (await client()).getMessagePage('100', { from: '2' })
      expect(page.messages.map(value => value.log_id)).toEqual(['3'])
      expect(page.complete).toBe(true)
    })
  }

  for (const chatInfo of [
    { chatId: 100, lastLogId: Long.ZERO, left: true },
    { chatId: 200, lastLogId: Long.ZERO },
    { chatId: 100 },
    { chatId: 100, lastLogId: -1 },
    { chatId: 100, lastLogId: Number.MAX_SAFE_INTEGER + 1 },
    { chatId: 100, lastLogId: '18446744073709551616' },
  ]) {
    it(`rejects an invalid forward watermark or room: ${JSON.stringify(chatInfo)}`, async () => {
      info.mockResolvedValueOnce(packet({ chatInfo }))
      await expect((await client()).getMessagePage('100'))
        .rejects.toMatchObject({ code: 'get_message_page_failed' })
      expect(sync).not.toHaveBeenCalled()
    })
  }

  it('keeps a progressing nonterminal page and does not claim a complete suffix', async () => {
    sync.mockResolvedValueOnce(packet({ chatLogs: [log(2)], isOK: false }))
    const page = await (await client()).getMessagePage('100', { from: '1' })
    expect(page.messages.map(value => value.log_id)).toEqual(['2'])
    expect(page.next_cursor).toBe('2')
    expect(page.complete).toBe(false)
  })

  it('keeps truncation lossless even when the provider reached the watermark', async () => {
    sync.mockResolvedValueOnce(packet({ chatLogs: [log(3), log(2)], isOK: true }))
    const page = await (await client()).getMessagePage('100', { from: '1', count: 1 })
    expect(page.messages.map(value => value.log_id)).toEqual(['2'])
    expect(page.next_cursor).toBe('2')
    expect(page.complete).toBe(false)
  })
})


// Behavior port of KiwiTalk chat.rs apply_sync_page/update_forward and its
// empty/overlap/terminal-gap/wrong-room tests. Rust persistence is not copied.
// dlwltkd/kiwitalk@912528b6407a02a1f9b17cbc6fa3331497e6cabc, Apache-2.0.
// See protocol/NOTICE.md for source, attribution and the deliberate differences.
describe('donor incremental continuation', () => {
  it('preserves a validated prefix and resumes after it when the next bulk page is empty', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(2), log(1)], eof: false }))
      .mockResolvedValueOnce(packet({ chatLogs: [], eof: false }))
    info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 4 } }))
    sync.mockResolvedValueOnce(packet({ chatLogs: [log(3), log(4)], isOK: false }))
    const values = await (await client()).getMessages('100', { count: 4 })
    expect(values.map(value => value.log_id)).toEqual(['1', '2', '3', '4'])
    expect(mchat.mock.calls.map(call => String(call[1][0]))).toEqual(['0', '2'])
    expect(sync.mock.calls.map(call => call.map(value => String(value)))).toEqual([['100', '0', '2', '4']])
  })

  it('keeps the same prefix on the existing eligible same-session bulk failure path', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
      .mockRejectedValueOnce(new Error('synthetic eligible bulk read failure'))
    info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 4 } }))
    sync.mockResolvedValueOnce(packet({ chatLogs: [log(3), log(4)], isOK: false }))
    expect((await (await client()).getMessages('100', { count: 4 })).map(value => value.log_id))
      .toEqual(['1', '2', '3', '4'])
    expect(String(sync.mock.calls[0]?.[2])).toBe('2')
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh same-room target before calling an empty tail complete', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
      .mockResolvedValueOnce(packet({ chatLogs: [], eof: true }))
    info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 2 } }))
    expect((await (await client()).getMessages('100', { count: 2 })).map(value => value.log_id))
      .toEqual(['1', '2'])
    expect(info).toHaveBeenCalledTimes(1)
    expect(sync).not.toHaveBeenCalled()
  })

  for (const body of [
    { chatInfo: { chatId: 200, lastLogId: 2 } },
    { chatInfo: { chatId: 100, lastLogId: 2, left: true } },
  ]) {
    it(`does not publish the preserved prefix when target identity is invalid: ${JSON.stringify(body)}`, async () => {
      mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
        .mockResolvedValueOnce(packet({ chatLogs: [], eof: true }))
      info.mockResolvedValueOnce(packet(body))
      await expect((await client()).getMessages('100', { count: 2 }))
        .rejects.toMatchObject({ code: 'get_messages_failed' })
      expect(sync).not.toHaveBeenCalled()
    })
  }

  it('retains failure instead of returning an old prefix when the remaining interval is unavailable', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
      .mockResolvedValueOnce(packet({ chatLogs: [], eof: false }))
    info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 4 } }))
    sync.mockResolvedValueOnce(packet({ chatLogs: null, isOK: true }))
    await expect((await client()).getMessages('100', { count: 4 }))
      .rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(String(sync.mock.calls[0]?.[2])).toBe('2')
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('preserves native order, overlap deduplication and exact large cursor across the handoff', async () => {
    const a = '9007199254740993', b = '9007199254740994', c = '9007199254740995'
    const row = (id: string) => ({ ...log(1), logId: Long.fromString(id), message: `synthetic-${id}` })
    mchat.mockResolvedValueOnce(packet({ chatLogs: [row(b), row(a), row(b)], eof: false }))
      .mockRejectedValueOnce(new Error('synthetic eligible bulk read failure'))
    info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: Long.fromString(c) } }))
    sync.mockResolvedValueOnce(packet({ chatLogs: [row(c), row(b)], isOK: false }))
    const values = await (await client()).getMessages('100', { count: 3 })
    expect(values.map(value => value.log_id)).toEqual([a, b, c])
    expect(values.map(value => value.message)).toEqual([a, b, c].map(id => `synthetic-${id}`))
    expect(String(sync.mock.calls[0]?.[2])).toBe(b)
  })

  it('does not turn a non-progressing bulk page into permission for another protocol read', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
      .mockResolvedValueOnce(packet({ chatLogs: [log(2), log(1)], eof: false }))
    await expect((await client()).getMessages('100', { count: 3 }))
      .rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(info).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('rejects a foreign-room bulk record before it can move or confirm the cursor', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(3, 200)], eof: true }))
    await expect((await client()).getMessages('100', { count: 3 }))
      .rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(info).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('does not hide an explicit provider denial with a history fallback', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
      .mockResolvedValueOnce({ statusCode: 0, body: { status: -401 } })
    await expect((await client()).getMessages('100', { count: 3 }))
      .rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(info).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('preserves the existing bulk page cap without resetting progress or falling through', async () => {
    let page = 0
    mchat.mockImplementation(async () => packet({ chatLogs: [log(++page)], eof: false }))
    await expect((await client()).getMessages('100', { count: 2 }))
      .rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(mchat).toHaveBeenCalledTimes(50)
    expect(info).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('does not complete preserved content when the fresh target regresses below that content', async () => {
    mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
      .mockResolvedValueOnce(packet({ chatLogs: [], eof: true }))
    info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 1 } }))
    await expect((await client()).getMessages('100', { count: 2 }))
      .rejects.toMatchObject({ code: 'get_messages_failed' })
    expect(sync).not.toHaveBeenCalled()
  })
})

// The fixed KiwiTalk Android response contract accepts an omitted/null collection.
// Reuse its empty-page rule: retain progress; empty alone is never completion.
describe('donor empty collection compatibility', () => {
  const shapes: Array<[string, Record<string, unknown>]> = [
    ['omitted', { eof: true }],
    ['null', { chatLogs: null, eof: true }],
    ['array', { chatLogs: [], eof: true }],
  ]
  for (const [name, body] of shapes) {
    it(`accepts ${name} bulk empty only after a fresh zero target`, async () => {
      mchat.mockResolvedValueOnce(packet(body))
      info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 0 } }))
      expect(await (await client()).getMessages('100')).toEqual([])
      expect(mchat).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledTimes(1)
      expect(sync).not.toHaveBeenCalled()
    })

    it(`retains the valid prefix across a ${name} bulk tail and retrieves only the missing suffix`, async () => {
      mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
        .mockResolvedValueOnce(packet(body))
      info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 4 } }))
      sync.mockResolvedValueOnce(packet({ chatLogs: [log(3), log(4)], isOK: false }))
      expect((await (await client()).getMessages('100', { count: 4 })).map(m => m.log_id))
        .toEqual(['1', '2', '3', '4'])
      expect(sync.mock.calls.map(call => call.map(value => String(value))))
        .toEqual([['100', '0', '2', '4']])
    })

    it(`does not re-fetch a current prefix after a ${name} bulk tail`, async () => {
      mchat.mockResolvedValueOnce(packet({ chatLogs: [log(1), log(2)], eof: false }))
        .mockResolvedValueOnce(packet(body))
      info.mockResolvedValueOnce(packet({ chatInfo: { chatId: 100, lastLogId: 2 } }))
      expect((await (await client()).getMessages('100', { count: 2 })).map(m => m.log_id))
        .toEqual(['1', '2'])
      expect(info).toHaveBeenCalledTimes(1)
      expect(sync).not.toHaveBeenCalled()
    })
  }

  for (const value of [{}, 42, '']) {
    it(`still rejects non-null malformed bulk collection ${JSON.stringify(value)}`, async () => {
      mchat.mockResolvedValueOnce(packet({ chatLogs: value, eof: true }))
      await expect((await client()).getMessages('100'))
        .rejects.toMatchObject({ code: 'get_messages_failed' })
      expect(info).not.toHaveBeenCalled()
      expect(sync).not.toHaveBeenCalled()
    })
  }
  for (const body of [{ status: -401, eof: true }, { status: -401, chatLogs: null, eof: true }]) {
    it(`does not normalize a provider refusal into an empty room: ${JSON.stringify(body)}`, async () => {
      mchat.mockResolvedValueOnce({ statusCode: 0, body })
      await expect((await client()).getMessages('100'))
        .rejects.toMatchObject({ code: 'get_messages_failed' })
      expect(info).not.toHaveBeenCalled()
      expect(sync).not.toHaveBeenCalled()
    })
  }
})

// KiwiTalk whole-page admission applies across requests too: no accepted cursor
// can be derived from a valid prefix followed by a foreign/invalid record.
describe('resumable forward page admission', () => {
  for (const fallback of [false, true]) {
    for (const bad of [ { ...log(4), chatId: Long.fromNumber(999) },
      { ...log(4), logId: Number.MAX_SAFE_INTEGER + 1 } ]) {
      it(`rejects whole ${fallback ? 'sync' : 'bulk'} page before checkpoint`, async () => {
        if (fallback) sync.mockResolvedValueOnce(packet({ chatLogs: [log(2), bad], isOK: false }))
        else mchat.mockResolvedValueOnce(packet({ chatLogs: [log(2), bad], eof: false }))
        await expect((await client()).getMessagePage('100', { from: '1', count: 2 })).rejects.toThrow()
      })
    }
  }
  it('rejects a SYNC record beyond its fresh target', async () => {
    sync.mockResolvedValueOnce(packet({ chatLogs: [log(2), log(4)], isOK: false }))
    await expect((await client()).getMessagePage('100', { from: '1', count: 2 })).rejects.toThrow()
  })
})

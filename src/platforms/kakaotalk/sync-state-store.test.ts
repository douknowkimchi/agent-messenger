import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as crypto from 'node:crypto'
import * as filePromises from 'node:fs/promises'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SyncState } from './protocol/types'
import { KakaoSyncStateStore } from './sync-state-store'

const DEVICE_UUID = 'device1'
const STATE_FILE = `kakaotalk-sync-state-${DEVICE_UUID}.json`
const TRUNCATED = '{\n  "version": 2,\n  "revision": 7,\n  "chatIds": ['
// Directory permissions cannot block writes on Windows or for root
const canRevokeWrite = process.platform !== 'win32' && process.getuid?.() !== 0
const canInspectPosixMode = process.platform !== 'win32'

function makeState(revision: number): SyncState {
  return {
    version: 2,
    revision,
    chatIds: [{ low: 100, high: 0 }],
    maxIds: [{ low: 999, high: 0 }],
    lastTokenId: { low: 0, high: 0 },
    lbk: 0,
  }
}

describe('KakaoSyncStateStore', () => {
  let tempDir: string
  let statePath: string
  let store: KakaoSyncStateStore

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kakao-sync-state-test-'))
    statePath = join(tempDir, STATE_FILE)
    store = new KakaoSyncStateStore(tempDir)
  })

  afterEach(async () => {
    await chmod(tempDir, 0o700)
    await rm(tempDir, { recursive: true })
  })

  describe('save', () => {
    async function getFileHandlePrototype() {
      const probePath = join(tempDir, '.file-handle-probe')
      const probe = await open(probePath, 'w')
      await probe.close()
      await rm(probePath)
      return Object.getPrototypeOf(probe) as typeof probe
    }

    it('replaces the state file with valid JSON and no temp residue', async () => {
      await store.save(DEVICE_UUID, makeState(1))
      await store.save(DEVICE_UUID, makeState(2))

      expect(JSON.parse(await readFile(statePath, 'utf-8'))).toEqual(makeState(2))
      if (canInspectPosixMode) expect((await stat(statePath)).mode & 0o777).toBe(0o600)
      expect(await readdir(tempDir)).toEqual([STATE_FILE])
      expect(await store.load(DEVICE_UUID)).toEqual(makeState(2))
    })

    it('keeps the existing state file when serialization fails', async () => {
      await store.save(DEVICE_UUID, makeState(1))
      const before = await readFile(statePath, 'utf-8')
      const unserializable = { ...makeState(2), revision: 2n } as unknown as SyncState

      await expect(store.save(DEVICE_UUID, unserializable)).rejects.toThrow(TypeError)

      expect(await readFile(statePath, 'utf-8')).toBe(before)
      expect(await readdir(tempDir)).toEqual([STATE_FILE])
    })

    it('keeps the existing state file when a partial temp write fails', async () => {
      await store.save(DEVICE_UUID, makeState(1))
      const before = await readFile(statePath, 'utf-8')
      const fileHandlePrototype = await getFileHandlePrototype()
      const originalWriteFile = fileHandlePrototype.writeFile
      const writeSpy = spyOn(fileHandlePrototype, 'writeFile').mockImplementationOnce(async function (data) {
        const content = typeof data === 'string' ? data : data.toString()
        await originalWriteFile.call(this, content.slice(0, 12))
        throw Object.assign(new Error('injected partial write failure'), { code: 'EIO' })
      })

      try {
        await expect(store.save(DEVICE_UUID, makeState(2))).rejects.toMatchObject({ code: 'EIO' })
      } finally {
        writeSpy.mockRestore()
      }

      expect(await readFile(statePath, 'utf-8')).toBe(before)
      expect(await readdir(tempDir)).toEqual([STATE_FILE])
    })

    it('keeps the existing state file when syncing the temp file fails', async () => {
      await store.save(DEVICE_UUID, makeState(1))
      const before = await readFile(statePath, 'utf-8')
      const fileHandlePrototype = await getFileHandlePrototype()
      const syncSpy = spyOn(fileHandlePrototype, 'sync').mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('injected sync failure'), { code: 'EIO' })),
      )

      try {
        await expect(store.save(DEVICE_UUID, makeState(2))).rejects.toMatchObject({ code: 'EIO' })
      } finally {
        syncSpy.mockRestore()
      }

      expect(await readFile(statePath, 'utf-8')).toBe(before)
      expect(await readdir(tempDir)).toEqual([STATE_FILE])
    })

    it.skipIf(!canRevokeWrite)('keeps the existing state file when the temp file cannot be written', async () => {
      await store.save(DEVICE_UUID, makeState(1))
      const before = await readFile(statePath, 'utf-8')
      await chmod(tempDir, 0o500)

      await expect(store.save(DEVICE_UUID, makeState(2))).rejects.toMatchObject({ code: 'EACCES' })

      expect(await readFile(statePath, 'utf-8')).toBe(before)
      expect(await readdir(tempDir)).toEqual([STATE_FILE])
    })

    it('removes the temp file when the rename fails', async () => {
      await mkdir(statePath)
      await writeFile(join(statePath, 'keep'), 'occupied')

      await expect(store.save(DEVICE_UUID, makeState(1))).rejects.toThrow()

      expect(await readdir(tempDir)).toEqual([STATE_FILE])
      expect(await readdir(statePath)).toEqual(['keep'])
    })
  })


  describe('existing SER5 load contract', () => {
    it('returns missing without creating a file', async () => {
      expect(await store.load(DEVICE_UUID)).toBeUndefined()
      expect(await readdir(tempDir)).toEqual([])
    })
    it('keeps corrupt bytes in place and rejects rather than enabling a fallback login', async () => {
      await writeFile(statePath, TRUNCATED)
      await expect(store.load(DEVICE_UUID)).rejects.toThrow(SyntaxError)
      await expect(store.load(DEVICE_UUID)).rejects.toThrow(SyntaxError)
      expect(await readFile(statePath, 'utf-8')).toBe(TRUNCATED)
      expect(await readdir(tempDir)).toEqual([STATE_FILE])
    })
    it('preserves the existing null-state rejection', async () => {
      await writeFile(statePath, 'null')
      await expect(store.load(DEVICE_UUID)).rejects.toThrow(TypeError)
      expect(await readFile(statePath, 'utf-8')).toBe('null')
    })
    it.each([
      ['unsupported version', { ...makeState(1), version: 1 }],
      ['mismatched arrays', { ...makeState(1), maxIds: [] }],
      ['missing token', { ...makeState(1), lastTokenId: null }],
    ])('preserves missing-state treatment of valid JSON with %s', async (_name, state) => {
      const content = JSON.stringify(state)
      await writeFile(statePath, content)
      expect(await store.load(DEVICE_UUID)).toBeUndefined()
      expect(await readFile(statePath, 'utf-8')).toBe(content)
    })
  })

  describe('owned temporary files', () => {
    it('does not delete an existing file when exclusive create fails', async () => {
      await store.save(DEVICE_UUID, makeState(1))
      const before = await readFile(statePath, 'utf-8')
      const uuid = '00000000-0000-4000-8000-000000000001'
      const occupied = `${statePath}.${uuid}.tmp`
      await writeFile(occupied, 'another owner')
      const idSpy = spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
      try {
        await expect(store.save(DEVICE_UUID, makeState(2))).rejects.toMatchObject({ code: 'EEXIST' })
      } finally { idSpy.mockRestore() }
      expect(await readFile(occupied, 'utf-8')).toBe('another owner')
      expect(await readFile(statePath, 'utf-8')).toBe(before)
    })
    it('retains both save and cleanup errors without reporting a successful write', async () => {
      await mkdir(statePath)
      await writeFile(join(statePath, 'keep'), 'occupied')
      const cleanupFailure = Object.assign(new Error('synthetic cleanup refused'), { code: 'EACCES' })
      const cleanupSpy = spyOn(filePromises, 'rm').mockRejectedValueOnce(cleanupFailure)
      let error: unknown
      try { await store.save(DEVICE_UUID, makeState(1)) } catch (caught) { error = caught }
      finally { cleanupSpy.mockRestore() }
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[1]).toBe(cleanupFailure)
      expect((await readdir(tempDir)).filter(name => name.endsWith('.tmp'))).toHaveLength(1)
      expect(await readFile(join(statePath, 'keep'), 'utf-8')).toBe('occupied')
    })
  })
})

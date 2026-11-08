import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KakaoSyncStateStore } from '../dist/src/platforms/kakaotalk/sync-state-store.js'

// Native filesystem checks only. No client, credential manager, network or Bridge.
// Run the emitted SDK module on Linux as a non-root user. A skipped permission
// test is not a permission PASS. This does not simulate power loss or prove the
// final release package, server filesystem, or concurrent-writer policy.
const device = 'sdk02-linux-synthetic'
const filename = `kakaotalk-sync-state-${device}.json`
const linux = process.platform === 'linux'
const options = { skip: !linux, concurrency: false, timeout: 10000 }
const state = revision => ({ version: 2, revision, chatIds: [{ low: 100, high: 0 }],
  maxIds: [{ low: revision, high: 0 }], lastTokenId: { low: revision, high: 0 }, lbk: 0 })

async function fixture(body) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ser5-sdk02-linux-fs-'))
  const store = new KakaoSyncStateStore(root)
  try { await body({ root, path: join(root, filename), store }) }
  finally { await fs.rm(root, { recursive: true }) }
}

// Observe actual handles and let native write/sync/close/rename execute. Only a
// requested directory-sync fault is injected; all hooks are restored in finally.
async function observeSave(root, directoryFailure, body) {
  const originalOpen = fsPromises.open
  const originalRename = fsPromises.rename
  const events = []
  fsPromises.open = async function (path, ...args) {
    const handle = await originalOpen.call(this, path, ...args)
    const kind = String(path) === root ? 'directory' : 'file'
    const originalSync = handle.sync.bind(handle)
    const originalClose = handle.close.bind(handle)
    events.push(`${kind}:open`)
    handle.sync = async () => {
      events.push(`${kind}:sync`)
      if (kind === 'directory' && directoryFailure) throw directoryFailure
      return originalSync()
    }
    handle.close = async () => { events.push(`${kind}:close`); return originalClose() }
    return handle
  }
  fsPromises.rename = async function (...args) {
    events.push('rename')
    return originalRename.apply(this, args)
  }
  syncBuiltinESMExports()
  try { await body(events) }
  finally {
    fsPromises.open = originalOpen
    fsPromises.rename = originalRename
    syncBuiltinESMExports()
  }
}

test('Linux atomic replacement uses 0600 and orders file sync before rename and directory sync', options, async () => {
  await fixture(async ({ root, path, store }) => {
    await store.save(device, state(1))
    await fs.chmod(path, 0o644)
    const oldInode = (await fs.stat(path)).ino
    await observeSave(root, undefined, async events => {
      await store.save(device, state(2))
      assert.deepEqual(events, ['file:open', 'file:sync', 'file:close', 'rename',
        'directory:open', 'directory:sync', 'directory:close'])
    })
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600)
    assert.notEqual((await fs.stat(path)).ino, oldInode)
    assert.deepEqual(await store.load(device), state(2))
    assert.deepEqual(await fs.readdir(root), [filename])
  })
})

test('Linux non-root directory write denial preserves the old state without a temporary file',
  { ...options, skip: !linux || process.getuid?.() === 0 }, async () => {
    assert.notEqual(process.getuid(), 0)
    await fixture(async ({ root, path, store }) => {
      await store.save(device, state(1))
      const previous = await fs.readFile(path)
      const previousMode = (await fs.stat(root)).mode & 0o777
      await fs.chmod(root, 0o500)
      try {
        await assert.rejects(store.save(device, state(2)), error => error.code === 'EACCES')
        assert.deepEqual(await fs.readFile(path), previous)
        assert.deepEqual(await fs.readdir(root), [filename])
      } finally {
        // Restore only this fixture's permission fault before normal cleanup.
        await fs.chmod(root, previousMode)
      }
    })
  })

test('directory sync failure after rename is reported while the new file remains present', options, async () => {
  await fixture(async ({ root, path, store }) => {
    await store.save(device, state(1))
    const fault = Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' })
    await observeSave(root, fault, async events => {
      await assert.rejects(store.save(device, state(2)), error => error === fault)
      assert.deepEqual(events, ['file:open', 'file:sync', 'file:close', 'rename',
        'directory:open', 'directory:sync', 'directory:close'])
    })
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), state(2))
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600)
    assert.deepEqual(await fs.readdir(root), [filename])
    // A later explicit caller may save; the failed call itself did not retry.
    await store.save(device, state(3))
    assert.deepEqual(await store.load(device), state(3))
  })
})

test('directory handle open failure after rename is reported and does not remove the new state', options, async () => {
  await fixture(async ({ root, path, store }) => {
    await store.save(device, state(1))
    const originalOpen = fsPromises.open
    const fault = Object.assign(new Error('synthetic directory open failure'), { code: 'EACCES' })
    let failures = 0
    fsPromises.open = async function (path, ...args) {
      if (String(path) === root) { failures++; throw fault }
      return originalOpen.call(this, path, ...args)
    }
    syncBuiltinESMExports()
    try { await assert.rejects(store.save(device, state(2)), error => error === fault) }
    finally { fsPromises.open = originalOpen; syncBuiltinESMExports() }
    assert.equal(failures, 1)
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), state(2))
    assert.deepEqual(await fs.readdir(root), [filename])
  })
})

test('bounded Linux readers observe complete states during sequential atomic saves', options, async () => {
  await fixture(async ({ root, path, store }) => {
    await store.save(device, state(0))
    const allowed = Array.from({ length: 13 }, (_, i) => JSON.stringify(state(i), null, 2))
    let readCount = 0
    const reader = async () => {
      for (let i = 0; i < 48; i++) {
        const text = await fs.readFile(path, 'utf8')
        assert.ok(allowed.includes(text), 'reader saw incomplete or unrecognized bytes')
        JSON.parse(text)
        readCount++
      }
    }
    const writer = async () => { for (let i = 1; i <= 12; i++) await store.save(device, state(i)) }
    const outcomes = await Promise.allSettled([reader(), writer()])
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
    assert.equal(readCount, 48)
    assert.deepEqual(await store.load(device), state(12))
    assert.deepEqual(await fs.readdir(root), [filename])
  })
})

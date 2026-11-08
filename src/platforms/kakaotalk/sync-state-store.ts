import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { getConfigDir } from '../../shared/utils/config-dir'
import type { SyncState } from './protocol/types'

export class KakaoSyncStateStore {
  private configDir: string

  constructor(configDir?: string) {
    this.configDir = configDir ?? getConfigDir()
  }

  private getStatePath(deviceUuid: string): string {
    return join(this.configDir, `kakaotalk-sync-state-${deviceUuid}.json`)
  }

  async load(deviceUuid: string): Promise<SyncState | undefined> {
    const path = this.getStatePath(deviceUuid)
    if (!existsSync(path)) return undefined
    const content = await readFile(path, 'utf-8')

    const parsed = JSON.parse(content) as Partial<SyncState>

    if (
      parsed.version !== 2 ||
      typeof parsed.revision !== 'number' ||
      !Array.isArray(parsed.chatIds) ||
      !Array.isArray(parsed.maxIds) ||
      parsed.chatIds.length !== parsed.maxIds.length ||
      !parsed.lastTokenId ||
      typeof parsed.lbk !== 'number'
    ) {
      return undefined
    }

    return parsed as SyncState
  }

  async save(deviceUuid: string, state: SyncState): Promise<void> {
    const content = JSON.stringify(state, null, 2)
    await mkdir(this.configDir, { recursive: true })
    const path = this.getStatePath(deviceUuid)
    const tmpPath = `${path}.${randomUUID()}.tmp`

    let created = false
    try {
      const file = await open(tmpPath, 'wx', 0o600)
      created = true
      try {
        await file.writeFile(content)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(tmpPath, path)
    } catch (error) {
      // A failed exclusive open does not grant ownership of an existing file.
      if (created) {
        try {
          await rm(tmpPath)
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new AggregateError([error, cleanupError], 'Sync-state save and owned-temp cleanup failed', { cause: error })
          }
        }
      }
      throw error
    }

    await this.syncConfigDir()
  }

  private async syncConfigDir(): Promise<void> {
    // Windows cannot open a directory handle to fsync it
    if (process.platform === 'win32') return

    const dir = await open(this.configDir, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }
}

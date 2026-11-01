import type { SpawnResult } from './process.js'

/** Metadata for the cached All-in-One Runtime Installer release. */
export interface RedistCache {
  schemaVersion: 1
  version: string
  assetName: string
  downloadedAt: string
  release: {
    date: string
    download: string
    notesUrl: string
  }
}

export interface RedistRelease {
  version: string
  date: string
  download: string
  notesUrl: string
  assetName: string
}

export interface RedistInstallResult {
  cache: RedistCache
  cachePath: string
  reusedCache: boolean
  execution: SpawnResult
}

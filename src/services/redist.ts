import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { redistCacheSchema, redistReleaseSchema } from '../schemas/index.js'
import type {
  ContainerConfig,
  GithubRelease,
  Paths,
  RedistCache,
  RedistInstallResult,
  RedistRelease
} from '../types/index.js'
import { findFile, redistMetadataFile, redistVersionDirectory } from '../utils/filesystem.js'
import { readJson, writeJson } from '../utils/json.js'
import { parseWithSchema } from '../utils/validation.js'
import { runRuntime, stopWineServer } from './launch.js'
import { downloadFile, extractZip, fetchJson } from './network.js'
import { ensurePaths, getPaths } from './paths.js'
import { componentRuntimeEnvironment } from '../utils/runtimeEnvironment.js'
import { prepareContainer } from './containers.js'

const REDIST_RELEASE_URL = 'https://api.github.com/repos/BloopSmasher/All-in-One-Runtime-Installer/releases/latest'
const AUTO_ADMIN_BATCH = 'All in One Runtime Installer (AutoAdmin).bat'

async function latestRedistRelease(): Promise<RedistRelease> {
  const release = await fetchJson<GithubRelease>(REDIST_RELEASE_URL)
  const asset = release.assets.find((candidate) => /\.zip$/iu.test(candidate.name))
  if (!asset) throw new Error('The latest All-in-One Runtime Installer release does not provide a ZIP asset.')
  return parseWithSchema(
    redistReleaseSchema,
    {
      version: release.tag_name,
      date: release.published_at.slice(0, 10),
      download: asset.browser_download_url,
      notesUrl: release.html_url,
      assetName: asset.name
    },
    'latest All-in-One Runtime Installer release'
  )
}

async function readRedistCache(paths: Paths): Promise<RedistCache | undefined> {
  const metadata = redistMetadataFile(paths)
  if (!existsSync(metadata)) return undefined
  try {
    return parseWithSchema(redistCacheSchema, await readJson<unknown>(metadata), metadata)
  } catch {
    return undefined
  }
}

function cacheRecord(release: RedistRelease): RedistCache {
  return {
    schemaVersion: 1,
    version: release.version,
    assetName: release.assetName,
    downloadedAt: new Date().toISOString(),
    release: { date: release.date, download: release.download, notesUrl: release.notesUrl }
  }
}

async function cachedScript(paths: Paths, version: string): Promise<string | undefined> {
  const cachePath = redistVersionDirectory(paths, version)
  if (!existsSync(cachePath)) return undefined
  return findFile(cachePath, AUTO_ADMIN_BATCH)
}

/**
 * Fetches only GitHub release metadata on every invocation. A matching valid
 * cache is reused; otherwise the ZIP is downloaded and extracted transiently
 * below downloads/ before its extracted files are atomically cached in redist/.
 */
export async function cacheLatestRedist(
  paths = getPaths()
): Promise<{ cache: RedistCache; cachePath: string; reusedCache: boolean; script: string }> {
  await ensurePaths(paths)
  const release = await latestRedistRelease()
  const cachePath = redistVersionDirectory(paths, release.version)
  const script = await cachedScript(paths, release.version)
  if (script) {
    const existing = await readRedistCache(paths)
    const cache = existing?.version === release.version ? existing : cacheRecord(release)
    if (!existing || existing.version !== release.version) await writeJson(redistMetadataFile(paths), cache)
    return {
      cache,
      cachePath,
      reusedCache: true,
      script
    }
  }

  const safeVersion = release.version.replace(/[^A-Za-z0-9._-]+/g, '_')
  const archive = join(paths.downloads, `redist-${safeVersion}-${basename(release.assetName)}`)
  const staging = join(paths.downloads, `redist-${safeVersion}.extracting-${process.pid}-${Date.now()}`)
  console.error(`Downloading All-in-One Runtime Installer ${release.version}…`)
  await rm(staging, { recursive: true, force: true })
  await downloadFile(release.download, archive, `All-in-One Runtime Installer ${release.version}`)
  try {
    await extractZip(archive, staging)
    const extractedScript = await findFile(staging, AUTO_ADMIN_BATCH)
    if (!extractedScript) throw new Error(`Downloaded release does not contain ${AUTO_ADMIN_BATCH}.`)
    await rm(cachePath, { recursive: true, force: true })
    await rename(staging, cachePath)
    const cache = cacheRecord(release)
    await writeJson(redistMetadataFile(paths), cache)
    const cached = await cachedScript(paths, release.version)
    if (!cached) throw new Error(`Cached release does not contain ${AUTO_ADMIN_BATCH}.`)
    return { cache, cachePath, reusedCache: false, script: cached }
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
}

/** Runs the upstream interactive AutoAdmin redistributable installer in a prepared Wine container. */
export async function installContainerRedists(
  container: ContainerConfig,
  paths = getPaths()
): Promise<RedistInstallResult> {
  const cached = await cacheLatestRedist(paths)
  const prepared = await prepareContainer(container, paths)
  const execution = await (async () => {
    try {
      return await runRuntime(prepared.container, prepared.runtime, [basename(cached.script)], {
        protonVerb: prepared.runtime.kind === 'proton' ? 'waitforexitandrun' : 'run',
        cwd: dirname(cached.script),
        extraEnv: await componentRuntimeEnvironment(prepared.container, prepared.runtime)
      })
    } finally {
      await stopWineServer(prepared.container, prepared.runtime)
    }
  })()
  return { cache: cached.cache, cachePath: cached.cachePath, reusedCache: cached.reusedCache, execution }
}

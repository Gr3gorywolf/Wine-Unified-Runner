import { existsSync } from 'node:fs'
import { chmod, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { isRuntimeSource } from './config.js'
import { downloadFile, extractArchive, fetchJson, verifySha512 } from './network.js'
import { ensurePaths, getPaths, readJson, writeJson } from './paths.js'
import { assetMatchesArchitecture, isArchiveAsset, runtimeSources, sourcesForPlatform } from './sources.js'
import { installedRuntimeSchema, runtimeReleaseSchema } from './schemas/index.js'
import { parseWithSchema } from './utils/validation.js'
import type { InstallOptions, InstalledRuntime, Paths, RuntimeRelease, RuntimeSource } from './types/index.js'

interface GithubAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GithubRelease {
  tag_name: string
  published_at: string
  html_url: string
  assets: GithubAsset[]
}

function selectAsset(source: RuntimeSource, release: GithubRelease): GithubAsset | undefined {
  if (runtimeSources[source].stagingOnly) {
    return release.assets.find((asset) => asset.name.toLowerCase().includes('staging') && isArchiveAsset(asset.name))
  }
  return release.assets.find((asset) => assetMatchesArchitecture(source, asset.name))
}

function releaseName(source: RuntimeSource, tag: string): string {
  return source.startsWith('wine-') ? `Wine-${tag}` : tag
}

export async function listReleases(source?: RuntimeSource, limit = 30, includeAll = false): Promise<RuntimeRelease[]> {
  if (source && !runtimeSources[source]) throw new Error(`Unknown runtime source "${source}".`)
  const selected = source ? [runtimeSources[source]] : sourcesForPlatform(includeAll)
  const releases = await Promise.all(
    selected.map(async (info) => {
      const data = await fetchJson<GithubRelease[]>(`${info.apiUrl}?per_page=${Math.min(Math.max(limit, 1), 100)}`)
      const entries = data.flatMap((item) => {
        const asset = selectAsset(info.id, item)
        if (!asset) return []
        const checksum =
          info.id === 'ge-proton' || info.id === 'proton-cachyos'
            ? item.assets.find(
                (candidate) => candidate.name === asset.name.replace(/\.tar\.(gz|xz|zst)$/i, '.sha512sum')
              )?.browser_download_url
            : item.assets.find((candidate) => /sha512sum$/i.test(candidate.name))?.browser_download_url
        return [
          {
            source: info.id,
            version: releaseName(info.id, item.tag_name),
            date: item.published_at.slice(0, 10),
            download: asset.browser_download_url,
            size: asset.size,
            checksum,
            notesUrl: item.html_url
          } satisfies RuntimeRelease
        ]
      })
      const latest = entries[0]
      return latest ? [{ ...latest, version: 'latest', latest: true }, ...entries] : []
    })
  )
  return releases
    .flat()
    .map((release) => parseWithSchema(runtimeReleaseSchema, release, `runtime ${release.source}/${release.version}`))
}

export function runtimeId(source: RuntimeSource, version: string): string {
  return `${source}--${version.replace(/[^A-Za-z0-9._-]+/g, '_')}`
}

function metadataFile(path: string): string {
  return join(path, 'runtime.json')
}

export async function listInstalledRuntimes(paths = getPaths()): Promise<InstalledRuntime[]> {
  await ensurePaths(paths)
  const entries = await readdir(paths.runtimes, { withFileTypes: true })
  const installed: InstalledRuntime[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metadata = metadataFile(join(paths.runtimes, entry.name))
    if (!existsSync(metadata)) continue
    try {
      const runtime = parseWithSchema(installedRuntimeSchema, await readJson<unknown>(metadata), metadata)
      // Older CLI versions selected Contents/MacOS/wine from macOS bundles.
      // That is the Finder-facing application launcher, not the Wine CLI.
      // Repair metadata on discovery so existing self-contained installs are
      // fixed without downloading the runtime again.
      if (process.platform === 'darwin' && runtime.kind !== 'proton') {
        const bin = await findRuntimeBinary(runtime.path, runtime.kind)
        if (bin !== runtime.bin) {
          runtime.bin = bin
          const wineserver = join(dirname(bin), 'wineserver')
          runtime.wineserver = existsSync(wineserver) ? wineserver : undefined
          await writeJson(metadata, runtime)
        }
      }
      installed.push(runtime)
    } catch {
      // A partial download must not prevent listing healthy runtime installations.
    }
  }
  return installed.sort((a, b) => b.installedAt.localeCompare(a.installedAt))
}

export async function findInstalledRuntime(
  source: RuntimeSource,
  version: string,
  paths = getPaths()
): Promise<InstalledRuntime | undefined> {
  const installed = await listInstalledRuntimes(paths)
  return version === 'latest'
    ? installed.find((runtime) => runtime.source === source)
    : installed.find((runtime) => runtime.source === source && runtime.version === version)
}

async function resolveRelease(source: RuntimeSource, version: string): Promise<RuntimeRelease> {
  const releases = await listReleases(source, 100, true)
  const release = releases.find((candidate) => candidate.version === version)
  if (!release)
    throw new Error(
      `Version "${version}" was not found for ${source}. Run "wur runtime list --remote --source ${source}".`
    )
  return release
}

function possibleBinaries(kind: InstalledRuntime['kind']): string[] {
  if (kind === 'proton') return ['proton']
  return [
    // Wine/GPTK macOS archives are application bundles. This binary is the
    // command-line Wine loader; Contents/MacOS/wine is only the Finder-facing
    // bundle launcher and must never be selected for CLI launches.
    'Contents/Resources/wine/bin/wine64',
    'Contents/Resources/wine/bin/wine',
    'bin/wine64',
    'bin/wine',
    'wine/bin/wine64',
    'wine/bin/wine',
    'wine64',
    'wine'
  ]
}

function isFinderBundleLauncher(root: string, candidate: string): boolean {
  return process.platform === 'darwin' && relative(root, candidate) === join('Contents', 'MacOS', 'wine')
}

export async function findRuntimeBinary(root: string, kind: InstalledRuntime['kind']): Promise<string> {
  const found = possibleBinaries(kind)
    .map((candidate) => join(root, candidate))
    .find(existsSync)
  if (found) return found
  if (kind !== 'proton') {
    // Retain a fallback for unusual archive layouts, but do not accidentally
    // execute the .app entry point and make Finder flash open folders.
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
    while (queue.length) {
      const current = queue.shift()!
      if (current.depth > 8) continue
      let entries
      try {
        entries = await readdir(current.path, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const child = join(current.path, entry.name)
        if (
          (entry.isFile() || entry.isSymbolicLink()) &&
          ['wine', 'wine64'].includes(entry.name) &&
          !isFinderBundleLauncher(root, child)
        )
          return child
        if (entry.isDirectory()) queue.push({ path: child, depth: current.depth + 1 })
      }
    }
  }
  throw new Error(
    `Runtime was extracted, but no executable was found in ${root}. Expected one of: ${possibleBinaries(kind).join(', ')}`
  )
}

export async function installRuntime(
  source: RuntimeSource,
  requestedVersion = 'latest',
  force = false,
  paths = getPaths(),
  options: InstallOptions = {}
): Promise<InstalledRuntime> {
  if (!isRuntimeSource(source)) throw new Error(`Unknown runtime source "${source}".`)
  options.onProgress?.(0)
  await ensurePaths(paths)
  const alreadyInstalled = await findInstalledRuntime(source, requestedVersion, paths)
  if (alreadyInstalled && !force) {
    options.onProgress?.(100)
    return alreadyInstalled
  }

  const release = await resolveRelease(source, requestedVersion)
  const destination = join(paths.runtimes, runtimeId(source, release.version))
  const existingExact = await findInstalledRuntime(source, release.version, paths)
  if (existingExact && !force) {
    options.onProgress?.(100)
    return existingExact
  }

  const archive = join(paths.downloads, `${runtimeId(source, release.version)}-${release.download.split('/').at(-1)}`)
  if (!options.quiet) console.error(`Installing ${runtimeSources[source].label} ${release.version}…`)
  const digest = await downloadFile(release.download, archive, `${runtimeSources[source].label} ${release.version}`, {
    quiet: options.quiet,
    onProgress: (progress) => options.onProgress?.(progress * 0.9)
  })
  if (release.checksum) {
    await verifySha512(release.checksum, digest)
    options.onProgress?.(93)
  }

  const staging = `${destination}.extracting-${process.pid}-${Date.now()}`
  await rm(staging, { recursive: true, force: true })
  try {
    await extractArchive(archive, staging, 1, options.quiet)
    options.onProgress?.(97)
    const kind = runtimeSources[source].kind
    const bin = await findRuntimeBinary(staging, kind)
    try {
      await chmod(bin, 0o755)
    } catch {
      /* archive permissions are normally sufficient */
    }
    const relativeBin = bin.slice(staging.length + 1)
    const wineserverCandidate = join(join(bin, '..'), 'wineserver')
    const installed: InstalledRuntime = {
      id: runtimeId(source, release.version),
      source,
      version: release.version,
      kind,
      path: destination,
      bin: join(destination, relativeBin),
      wineserver: existsSync(wineserverCandidate)
        ? join(destination, wineserverCandidate.slice(staging.length + 1))
        : undefined,
      installedAt: new Date().toISOString(),
      release: { date: release.date, download: release.download, notesUrl: release.notesUrl }
    }
    await writeJson(metadataFile(staging), installed)
    if (existsSync(destination)) {
      if (!force) {
        options.onProgress?.(100)
        return parseWithSchema(
          installedRuntimeSchema,
          await readJson<unknown>(metadataFile(destination)),
          metadataFile(destination)
        )
      }
      await rm(destination, { recursive: true, force: true })
    }
    await rename(staging, destination)
    options.onProgress?.(100)
    if (!options.quiet) console.error(`Installed ${installed.id} in ${destination}`)
    return parseWithSchema(installedRuntimeSchema, installed, metadataFile(staging))
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  } finally {
    await rm(archive, { force: true })
  }
}

/** Permanently removes one runtime managed by this portable CLI installation. */
export async function removeRuntime(
  source: RuntimeSource,
  version = 'latest',
  paths = getPaths()
): Promise<Pick<InstalledRuntime, 'id' | 'source' | 'version' | 'path'>> {
  if (!isRuntimeSource(source)) throw new Error(`Unknown runtime source "${source}".`)
  const installed = await findInstalledRuntime(source, version, paths)
  if (!installed) throw new Error(`Runtime ${source}/${version} is not installed.`)
  // Derive the target from the managed runtime root, never from a mutable
  // path stored in runtime.json.
  const target = join(paths.runtimes, runtimeId(installed.source, installed.version))
  if (!existsSync(target)) throw new Error(`Runtime metadata exists, but its managed files are missing: ${target}`)
  await rm(target, { recursive: true, force: false })
  return { id: installed.id, source: installed.source, version: installed.version, path: target }
}

export async function getRuntime(
  source: RuntimeSource,
  version: string,
  paths = getPaths()
): Promise<InstalledRuntime> {
  const configured = await findInstalledRuntime(source, version, paths)
  return configured || installRuntime(source, version, false, paths)
}

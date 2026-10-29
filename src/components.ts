import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadFile, extractArchive, fetchJson } from './network.js'
import { ensurePaths, getPaths, readJson, writeJson } from './paths.js'
import { compatibleComponentRecommendations, componentNames, isArchiveAsset } from './sources.js'
import { componentReleaseSchema, installedComponentSchema } from './schemas/index.js'
import { parseWithSchema } from './utils/validation.js'
import type { ComponentName, ComponentRelease, InstallOptions, InstalledComponent, Paths } from './types/index.js'

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

interface LutrisRuntime {
  name: string
  url: string
  created_at?: string
}

const githubComponents: Partial<Record<ComponentName, { apiUrl: string; asset: (asset: GithubAsset) => boolean; strip: number }>> = {
  dxvk: {
    apiUrl: 'https://api.github.com/repos/doitsujin/dxvk/releases',
    asset: (asset) => /^dxvk-.*\.tar\.(gz|xz|zst)$/i.test(asset.name),
    strip: 1
  },
  'dxvk-nvapi': {
    apiUrl: 'https://api.github.com/repos/jp7677/dxvk-nvapi/releases',
    asset: (asset) => /^dxvk-nvapi-.*\.tar\.(gz|xz|zst)$/i.test(asset.name),
    // The upstream archive has x64/x32 at its root; this matches Heroic's handling.
    strip: 0
  },
  vkd3d: {
    apiUrl: 'https://api.github.com/repos/HansKristian-Work/vkd3d-proton/releases',
    asset: (asset) => /^vkd3d-proton-.*\.tar\.(gz|xz|zst)$/i.test(asset.name),
    strip: 1
  },
  'dxvk-macos': {
    apiUrl: 'https://api.github.com/repos/Gcenx/DXVK-macOS/releases',
    // Heroic deliberately avoids the -builtin variant until WINEDLLPATH_PREPEND is used.
    asset: (asset) => isArchiveAsset(asset.name) && !asset.name.includes('-builtin'),
    strip: 1
  },
  dxmt: {
    apiUrl: 'https://api.github.com/repos/3Shain/dxmt/releases',
    asset: (asset) => isArchiveAsset(asset.name),
    strip: 1
  }
}

const lutrisComponentMap: Partial<Record<ComponentName, string>> = {
  'eac-runtime': 'eac_runtime',
  'battleye-runtime': 'battleye_runtime',
  umu: 'umu'
}

function componentPath(paths: Paths, name: ComponentName, version: string): string {
  return join(paths.components, name, version.replace(/[^A-Za-z0-9._-]+/g, '_'))
}

function metadataFile(path: string): string {
  return join(path, 'component.json')
}

export async function listComponentReleases(name?: ComponentName, limit = 30, includeAll = false): Promise<ComponentRelease[]> {
  const requested = name ? [name] : compatibleComponentRecommendations(includeAll).map((component) => component.name)
  const releases: ComponentRelease[] = []
  for (const component of requested) {
    const github = githubComponents[component]
    if (github) {
      const data = await fetchJson<GithubRelease[]>(`${github.apiUrl}?per_page=${Math.min(Math.max(limit, 1), 100)}`)
      for (const release of data) {
        const asset = release.assets.find(github.asset)
        if (!asset) continue
        releases.push({
          name: component,
          version: release.tag_name,
          date: release.published_at.slice(0, 10),
          download: asset.browser_download_url,
          size: asset.size,
          notesUrl: release.html_url,
          stripComponents: github.strip
        })
      }
      continue
    }
    const runtimeName = lutrisComponentMap[component]
    if (!runtimeName) continue
    const allRuntimes = await fetchJson<LutrisRuntime[]>('https://lutris.net/api/runtimes')
    const runtime = allRuntimes.find((entry) => entry.name === runtimeName)
    if (!runtime) throw new Error(`Lutris did not publish a runtime named ${runtimeName}`)
    releases.push({
      name: component,
      version: runtime.created_at || 'latest',
      date: (runtime.created_at || new Date().toISOString()).slice(0, 10),
      download: runtime.url,
      size: 0,
      notesUrl: 'https://lutris.net/api/runtimes',
      stripComponents: 1
    })
  }
  return releases.map((release) => parseWithSchema(componentReleaseSchema, release, `component ${release.name}/${release.version}`))
}

export async function listInstalledComponents(paths = getPaths()): Promise<InstalledComponent[]> {
  await ensurePaths(paths)
  const listed: InstalledComponent[] = []
  for (const name of componentNames) {
    const parent = join(paths.components, name)
    if (!existsSync(parent)) continue
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = metadataFile(join(parent, entry.name))
      if (!existsSync(file)) continue
      try { listed.push(parseWithSchema(installedComponentSchema, await readJson<unknown>(file), file)) } catch { /* omit incomplete install */ }
    }
  }
  return listed.sort((a, b) => b.installedAt.localeCompare(a.installedAt))
}

export async function findInstalledComponent(name: ComponentName, version: string, paths = getPaths()): Promise<InstalledComponent | undefined> {
  const installed = await listInstalledComponents(paths)
  return version === 'latest'
    ? installed.find((component) => component.name === name)
    : installed.find((component) => component.name === name && component.version === version)
}

export async function installComponent(
  name: ComponentName,
  requestedVersion = 'latest',
  force = false,
  paths = getPaths(),
  options: InstallOptions = {}
): Promise<InstalledComponent> {
  if (!componentNames.includes(name)) throw new Error(`Unknown component "${name}".`)
  options.onProgress?.(0)
  await ensurePaths(paths)
  const existing = await findInstalledComponent(name, requestedVersion, paths)
  if (existing && !force) {
    options.onProgress?.(100)
    return existing
  }
  const release = (await listComponentReleases(name, 100)).find((candidate) => requestedVersion === 'latest' || candidate.version === requestedVersion)
  if (!release) throw new Error(`Version "${requestedVersion}" was not found for component ${name}.`)
  const exact = await findInstalledComponent(name, release.version, paths)
  if (exact && !force) {
    options.onProgress?.(100)
    return exact
  }

  const destination = componentPath(paths, name, release.version)
  const archive = join(paths.downloads, `${name}-${release.version.replace(/[^A-Za-z0-9._-]+/g, '_')}-${release.download.split('/').at(-1)}`)
  const staging = `${destination}.extracting-${process.pid}-${Date.now()}`
  if (!options.quiet) console.error(`Installing ${name} ${release.version}…`)
  await downloadFile(release.download, archive, `${name} ${release.version}`, {
    quiet: options.quiet,
    onProgress: (progress) => options.onProgress?.(progress * 0.9)
  })
  try {
    await rm(staging, { recursive: true, force: true })
    await extractArchive(archive, staging, release.stripComponents, options.quiet)
    options.onProgress?.(97)
    const installed: InstalledComponent = {
      name,
      version: release.version,
      path: destination,
      installedAt: new Date().toISOString(),
      release: { date: release.date, download: release.download, notesUrl: release.notesUrl }
    }
    await writeJson(metadataFile(staging), installed)
    await mkdir(join(paths.components, name), { recursive: true })
    if (existsSync(destination)) {
      if (!force) {
        options.onProgress?.(100)
        return parseWithSchema(installedComponentSchema, await readJson<unknown>(metadataFile(destination)), metadataFile(destination))
      }
      await rm(destination, { recursive: true, force: true })
    }
    await rename(staging, destination)
    options.onProgress?.(100)
    if (!options.quiet) console.error(`Installed ${name} ${release.version}`)
    return installed
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  } finally {
    await rm(archive, { force: true })
  }
}

/** Permanently removes one component managed by this portable CLI installation. */
export async function removeComponent(name: ComponentName, version = 'latest', paths = getPaths()): Promise<Pick<InstalledComponent, 'name' | 'version' | 'path'>> {
  if (!componentNames.includes(name)) throw new Error(`Unknown component "${name}".`)
  const installed = await findInstalledComponent(name, version, paths)
  if (!installed) throw new Error(`Component ${name}/${version} is not installed.`)
  // Keep deletion constrained to components/<name>/<sanitized-version>, not
  // to the path recorded in an externally editable metadata file.
  const target = componentPath(paths, installed.name, installed.version)
  if (!existsSync(target)) throw new Error(`Component metadata exists, but its managed files are missing: ${target}`)
  await rm(target, { recursive: true, force: false })
  return { name: installed.name, version: installed.version, path: target }
}

async function findDirectory(root: string, names: string[]): Promise<string | undefined> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth > 4) continue
    let entries
    try { entries = await readdir(current.path, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const child = join(current.path, entry.name)
      if (entry.isDirectory() && names.includes(entry.name)) return child
      if (entry.isDirectory()) queue.push({ path: child, depth: current.depth + 1 })
    }
  }
  return undefined
}

async function copyDllDirectory(source: string | undefined, destination: string): Promise<string[]> {
  if (!source) return []
  await mkdir(destination, { recursive: true })
  const copied: string[] = []
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dll')) continue
    await copyFile(join(source, entry.name), join(destination, entry.name))
    copied.push(entry.name)
  }
  return copied
}

/** Copies a downloaded DXVK-family component into a Wine prefix. Registry overrides are applied by the caller. */
export async function applyDllComponent(component: InstalledComponent, prefix: string): Promise<string[]> {
  const x64 = await findDirectory(component.path, ['x64'])
  const x32 = await findDirectory(component.path, component.name === 'vkd3d' ? ['x86', 'x32'] : ['x32', 'x86'])
  if (!x64 && !x32) throw new Error(`${component.name} ${component.version} does not contain x64, x32, or x86 DLL directories.`)
  const windows = join(prefix, 'drive_c', 'windows')
  const copied = await Promise.all([
    copyDllDirectory(x64, join(windows, 'system32')),
    copyDllDirectory(x32, join(windows, 'syswow64'))
  ])
  return [...new Set(copied.flat())]
}

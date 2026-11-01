import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ComponentName, Paths } from '../types/index.js'
import { GAME_OVERRIDE_FILE } from './configOverrides.js'

export function assertContainerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('Container name must be 1–64 characters of letters, numbers, dot, underscore, or hyphen.')
  }
}

export function containerDirectory(paths: Paths, name: string): string {
  assertContainerName(name)
  return join(paths.containers, name)
}

export function containerFile(paths: Paths, name: string): string {
  return join(containerDirectory(paths, name), 'container.json')
}

/** The hand-authored, partial configuration consumed by `wur build`. */
export function containerManifestFile(paths: Paths, name: string): string {
  return join(containerDirectory(paths, name), 'config.json')
}

export function gameOverrideFile(executable: string): string {
  return join(dirname(executable), GAME_OVERRIDE_FILE)
}

export function componentPath(paths: Paths, name: ComponentName, version: string): string {
  return join(paths.components, name, version.replace(/[^A-Za-z0-9._-]+/g, '_'))
}

export function componentMetadataFile(path: string): string {
  return join(path, 'component.json')
}

export function runtimeMetadataFile(path: string): string {
  return join(path, 'runtime.json')
}

/** Metadata that records which All-in-One Runtime Installer release is cached. */
export function redistMetadataFile(paths: Paths): string {
  return join(paths.redist, 'cache.json')
}

export function redistVersionDirectory(paths: Paths, version: string): string {
  return join(paths.redist, version.replace(/[^A-Za-z0-9._-]+/g, '_'))
}

/** Finds the first directory with one of the requested names below a root. */
export async function findDirectory(root: string, names: string[], maxDepth = 4): Promise<string | undefined> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth > maxDepth) continue
    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current.path, entry.name)
      if (entry.isDirectory() && names.includes(entry.name)) return child
      if (entry.isDirectory()) queue.push({ path: child, depth: current.depth + 1 })
    }
  }
  return undefined
}

/** Finds a named regular file below an archive extraction root. */
export async function findFile(root: string, name: string, maxDepth = 4): Promise<string | undefined> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth > maxDepth) continue
    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current.path, entry.name)
      if (entry.name === name && entry.isFile()) return child
      if (entry.isDirectory()) queue.push({ path: child, depth: current.depth + 1 })
    }
  }
  return undefined
}

export async function copyDllDirectory(source: string | undefined, destination: string): Promise<string[]> {
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

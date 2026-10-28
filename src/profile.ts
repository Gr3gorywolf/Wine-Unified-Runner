import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readlink, readdir, rm, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { SHARED_WINE_USERNAME } from './launch.js'
import { getPaths } from './paths.js'
import type { ContainerConfig, InstalledRuntime, Paths } from './types.js'

const profileDirectories = [
  'AppData/Local',
  'AppData/LocalLow',
  'AppData/Roaming',
  'Contacts',
  'Desktop',
  'Documents',
  'Downloads',
  'Favorites',
  'Links',
  'Music',
  'Pictures',
  'Saved Games',
  'Searches',
  'Videos'
]

async function pathType(path: string): Promise<'directory' | 'file' | 'symlink' | undefined> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'directory'
    return 'file'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Merge an old per-prefix profile without following its host-directory
 * symlinks. Existing shared files win, so migrating another prefix cannot
 * overwrite saves that are already in the shared profile.
 */
async function mergeProfile(source: string, destination: string): Promise<void> {
  const type = await pathType(source)
  if (!type) return
  if (type === 'symlink') {
    // Wine normally links Documents/Desktop/etc. to the host home. Replace
    // those links with portable directories rather than copying host data.
    await mkdir(destination, { recursive: true })
    return
  }
  if (type === 'file') {
    if (!existsSync(destination)) {
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
    return
  }
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await mergeProfile(join(source, entry.name), join(destination, entry.name))
  }
}

function winePrefix(container: ContainerConfig, runtime: InstalledRuntime): string {
  return runtime.kind === 'proton' ? join(container.prefix, 'pfx') : container.prefix
}

/**
 * Makes C:\\users\\user in every prefix resolve to the one portable user/
 * directory beside the CLI. Legacy profile data is copied conservatively and
 * left in place as a backup.
 */
export async function ensureSharedUserProfile(
  container: ContainerConfig,
  runtime: InstalledRuntime,
  paths: Paths = getPaths()
): Promise<void> {
  await mkdir(paths.user, { recursive: true })
  await Promise.all(profileDirectories.map((directory) => mkdir(join(paths.user, directory), { recursive: true })))

  const users = join(winePrefix(container, runtime), 'drive_c', 'users')
  await mkdir(users, { recursive: true })

  // Import data from legacy usernames without deleting their original copy.
  for (const entry of await readdir(users, { withFileTypes: true })) {
    if (entry.name === 'Public' || entry.name === SHARED_WINE_USERNAME || !entry.isDirectory()) continue
    await mergeProfile(join(users, entry.name), paths.user)
  }

  const profile = join(users, SHARED_WINE_USERNAME)
  const type = await pathType(profile)
  if (type === 'symlink') {
    const target = resolve(dirname(profile), await readlink(profile))
    if (target === resolve(paths.user)) return
  }
  if (type) {
    await mergeProfile(profile, paths.user)
    await rm(profile, { recursive: true, force: true })
  }

  // A relative link keeps the complete CLI directory movable as one unit.
  await symlink(relative(dirname(profile), paths.user), profile, 'dir')
}

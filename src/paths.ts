import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Paths } from './types.js'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

export function getPaths(): Paths {
  const configuredRoot = process.env.PROTON_CLI_HOME
  const root = configuredRoot
    ? resolve(configuredRoot)
    // dist/src contains the executable module and dist is the portable CLI folder.
    // Keeping state here makes removing this folder a complete uninstall.
    : resolve(moduleDirectory, '..')

  const installedDefaults = resolve(moduleDirectory, '..', 'defaults.json')
  const developmentDefaults = resolve(moduleDirectory, '..', 'resources', 'defaults.json')

  return {
    root,
    user: join(root, 'user'),
    containers: join(root, 'containers'),
    runtimes: join(root, 'runtimes'),
    components: join(root, 'components'),
    downloads: join(root, 'downloads'),
    appConfig: join(root, 'config', 'config.json'),
    // The template remains beside the executable; the editable, platform-aware
    // copy lives in the same self-contained installation under config/.
    defaults: join(root, 'config', 'defaults.json'),
    bundledDefaults: existsSync(installedDefaults)
      ? installedDefaults
      : developmentDefaults
  }
}

export async function ensurePaths(paths: Paths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.user, { recursive: true }),
    mkdir(paths.containers, { recursive: true }),
    mkdir(paths.runtimes, { recursive: true }),
    mkdir(paths.components, { recursive: true }),
    mkdir(paths.downloads, { recursive: true })
  ])
}

export async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read JSON file ${file}: ${message}`)
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Paths } from '../types/index.js'

// Replaced at bundle time by scripts/build-binary.mjs. `typeof` keeps the
// regular TypeScript/Node build safe when the compile-time constant is absent.
declare const __WUR_STANDALONE__: boolean | undefined

const standaloneBinary = typeof __WUR_STANDALONE__ !== 'undefined' && __WUR_STANDALONE__
const moduleDirectory = standaloneBinary ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url))

/** The directory beside the binary that retains WUR's home selection. */
function installationRoot(): string {
  // dist/src/services contains this module and dist is the portable CLI folder.
  // Keeping state here makes removing this folder a complete uninstall.
  return standaloneBinary ? moduleDirectory : resolve(moduleDirectory, '..', '..')
}

function configuredHome(root: string): string | undefined {
  const configFile = join(root, 'config', 'config.json')
  if (!existsSync(configFile)) return undefined

  let value: unknown
  try {
    value = JSON.parse(readFileSync(configFile, 'utf8'))
  } catch {
    throw new Error(`Unable to read WUR configuration: ${configFile}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`WUR configuration must be an object: ${configFile}`)
  }
  const config = value as Record<string, unknown>
  if (!Object.hasOwn(config, 'home')) return undefined
  if (typeof config.home !== 'string' || !config.home.trim()) {
    throw new Error(`WUR configuration home must be a non-empty path: ${configFile}`)
  }
  return resolve(config.home)
}

function pathsForRoot(root: string): Paths {
  const installedDefaults = standaloneBinary
    ? resolve(moduleDirectory, 'defaults.json')
    : resolve(moduleDirectory, '..', '..', 'defaults.json')
  const developmentDefaults = standaloneBinary
    ? resolve(moduleDirectory, 'resources', 'defaults.json')
    : resolve(moduleDirectory, '..', '..', 'resources', 'defaults.json')
  const installedOverrideTemplate = standaloneBinary
    ? resolve(moduleDirectory, 'wur-overrides.template.jsonc')
    : resolve(moduleDirectory, '..', '..', 'wur-overrides.template.jsonc')
  const developmentOverrideTemplate = standaloneBinary
    ? resolve(moduleDirectory, 'resources', 'wur-overrides.template.jsonc')
    : resolve(moduleDirectory, '..', '..', 'resources', 'wur-overrides.template.jsonc')

  return {
    root,
    user: join(root, 'user'),
    containers: join(root, 'containers'),
    runtimes: join(root, 'runtimes'),
    components: join(root, 'components'),
    redist: join(root, 'redist'),
    downloads: join(root, 'downloads'),
    appConfig: join(root, 'config', 'config.json'),
    // The template remains beside the executable; the editable, platform-aware
    // copy lives in the same self-contained installation under config/.
    defaults: join(root, 'config', 'defaults.json'),
    bundledDefaults: existsSync(installedDefaults) ? installedDefaults : developmentDefaults,
    overrideTemplate: existsSync(installedOverrideTemplate) ? installedOverrideTemplate : developmentOverrideTemplate
  }
}

/** Returns the state paths for the persisted WUR home. */
export function getPaths(): Paths {
  const root = installationRoot()
  return pathsForRoot(configuredHome(root) || root)
}

/** Returns the paths beside the executable, regardless of the selected home. */
export function getInstallationPaths(): Paths {
  return pathsForRoot(installationRoot())
}

export async function ensurePaths(paths: Paths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.user, { recursive: true }),
    mkdir(paths.containers, { recursive: true }),
    mkdir(paths.runtimes, { recursive: true }),
    mkdir(paths.components, { recursive: true }),
    mkdir(paths.redist, { recursive: true }),
    mkdir(paths.downloads, { recursive: true })
  ])
}

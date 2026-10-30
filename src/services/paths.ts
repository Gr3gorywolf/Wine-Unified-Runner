import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Paths } from '../types/index.js'
export { readJson, writeJson } from '../utils/json.js'

// Replaced at bundle time by scripts/build-binary.mjs. `typeof` keeps the
// regular TypeScript/Node build safe when the compile-time constant is absent.
declare const __WUR_STANDALONE__: boolean | undefined

const standaloneBinary = typeof __WUR_STANDALONE__ !== 'undefined' && __WUR_STANDALONE__
const moduleDirectory = standaloneBinary ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url))

export function getPaths(): Paths {
  // PROTON_CLI_HOME remains a compatibility alias for pre-WUR installations.
  const configuredRoot = process.env.WUR_HOME || process.env.PROTON_CLI_HOME
  const root = configuredRoot
    ? resolve(configuredRoot)
    : // dist/src/services contains this module and dist is the portable CLI folder.
      // Keeping state here makes removing this folder a complete uninstall.
      standaloneBinary
      ? moduleDirectory
      : resolve(moduleDirectory, '..', '..')

  const installedDefaults = standaloneBinary
    ? resolve(moduleDirectory, 'defaults.json')
    : resolve(moduleDirectory, '..', '..', 'defaults.json')
  const developmentDefaults = standaloneBinary
    ? resolve(moduleDirectory, 'resources', 'defaults.json')
    : resolve(moduleDirectory, '..', '..', 'resources', 'defaults.json')
  const installedOverrideTemplate = standaloneBinary
    ? resolve(moduleDirectory, 'wur-overrides.template.ini')
    : resolve(moduleDirectory, '..', '..', 'wur-overrides.template.ini')
  const developmentOverrideTemplate = standaloneBinary
    ? resolve(moduleDirectory, 'resources', 'wur-overrides.template.ini')
    : resolve(moduleDirectory, '..', '..', 'resources', 'wur-overrides.template.ini')

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
    bundledDefaults: existsSync(installedDefaults) ? installedDefaults : developmentDefaults,
    overrideTemplate: existsSync(installedOverrideTemplate) ? installedOverrideTemplate : developmentOverrideTemplate
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

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { ensurePaths, getPaths, readJson, writeJson } from './paths.js'
import { appConfigSchema, containerConfigSchema, containerManifestSchema, containerRuntimeRefSchema, defaultsFileSchema } from './schemas/index.js'
import { GAME_OVERRIDE_FILE, overrideLaunchBooleanKeys, parseGameOverrides } from './utils/configOverrides.js'
import { readValidatedJson } from './utils/json.js'
import { onlyKeys } from './utils/objects.js'
import { parseWithSchema } from './utils/validation.js'
export { parseJsonValue, parseSetExpression, setAtPath } from './utils/settings.js'
export { GAME_OVERRIDE_FILE, parseGameOverrides } from './utils/configOverrides.js'
import type {
  AppConfig,
  ComponentSelection,
  ContainerConfig,
  ContainerComponents,
  ContainerRuntimeRef,
  GameOverrides,
  DefaultsFile,
  Paths,
  RuntimeSource
} from './types/index.js'

const validSources = new Set<RuntimeSource>([
  'ge-proton',
  'proton',
  'proton-cachyos',
  'wine-lutris',
  'wine-crossover',
  'wine-staging-macos',
  'game-porting-toolkit'
])

export function isRuntimeSource(value: string): value is RuntimeSource {
  return validSources.has(value as RuntimeSource)
}

export function defaultSourceForPlatform(): RuntimeSource {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'wine-crossover' : 'wine-staging-macos'
  }
  return 'ge-proton'
}

function nativeDefaults(): DefaultsFile {
  const isMac = process.platform === 'darwin'
  return {
    schemaVersion: 1,
    container: {
      runtime: { source: defaultSourceForPlatform(), version: 'latest' },
      architecture: 'win64',
      components: {
        dxvk: { enabled: true, version: 'latest' },
        dxvkNvapi: { enabled: false, version: 'latest' },
        vkd3d: { enabled: !isMac, version: 'latest' },
        eacRuntime: { enabled: !isMac, version: 'latest' },
        battleyeRuntime: { enabled: !isMac, version: 'latest' }
      },
      launch: {
        enableEsync: true,
        enableFsync: !isMac,
        enableMsync: isMac,
        enableWayland: false,
        enableHdr: false,
        enableWow64: false,
        showFps: false,
        dxvkFrameRate: null,
        fsr: false,
        fsrSharpness: 2,
        verboseLogs: false,
        environment: {}
      }
    }
  }
}

function platformizeDefaults(defaults: DefaultsFile): DefaultsFile {
  const copy = structuredClone(defaults)
  if (process.platform === 'darwin' && copy.container.runtime.source === 'ge-proton') {
    copy.container.runtime.source = defaultSourceForPlatform()
    copy.container.runtime.version = 'latest'
    copy.container.components.vkd3d.enabled = false
    copy.container.components.eacRuntime.enabled = false
    copy.container.components.battleyeRuntime.enabled = false
    copy.container.launch.enableFsync = false
    copy.container.launch.enableMsync = true
  }
  return copy
}

export async function loadDefaults(paths = getPaths()): Promise<DefaultsFile> {
  await ensurePaths(paths)
  if (!existsSync(paths.defaults)) {
    await mkdir(dirname(paths.defaults), { recursive: true })
    if (existsSync(paths.bundledDefaults)) {
      await copyFile(paths.bundledDefaults, paths.defaults)
    } else {
      await writeJson(paths.defaults, nativeDefaults())
    }
    const bundled = await readValidatedJson(paths.defaults, defaultsFileSchema)
    await writeJson(paths.defaults, platformizeDefaults(bundled))
  }
  const defaults = await readValidatedJson(paths.defaults, defaultsFileSchema)
  return defaults
}

export async function saveDefaults(defaults: DefaultsFile, paths = getPaths()): Promise<void> {
  validateDefaults(defaults, paths.defaults)
  await writeJson(paths.defaults, defaults)
}

export async function loadAppConfig(paths = getPaths()): Promise<AppConfig> {
  await ensurePaths(paths)
  if (!existsSync(paths.appConfig)) {
    const config: AppConfig = { schemaVersion: 1 }
    await writeJson(paths.appConfig, config)
    return config
  }
  const config = await readValidatedJson(paths.appConfig, appConfigSchema)
  return config
}

export async function saveAppConfig(config: AppConfig, paths = getPaths()): Promise<void> {
  await writeJson(paths.appConfig, config)
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

/** Creates the editable sidecar when absent, then parses the game's settings. */
export async function loadGameOverrides(executable: string, paths = getPaths()): Promise<{ file: string; overrides: GameOverrides }> {
  const file = gameOverrideFile(executable)
  if (!existsSync(file)) {
    if (!existsSync(paths.overrideTemplate)) {
      throw new Error(`WUR override template is missing: ${paths.overrideTemplate}`)
    }
    await mkdir(dirname(file), { recursive: true })
    await copyFile(paths.overrideTemplate, file)
  }
  return { file, overrides: parseGameOverrides(await readFile(file, 'utf8')) }
}

/** Applies non-selection overrides to an in-memory container for one launch. */
export function applyGameOverrides(container: ContainerConfig, overrides: GameOverrides): ContainerConfig {
  const result = structuredClone(container)
  if (overrides.runtime?.source !== undefined) result.runtime.source = overrides.runtime.source
  if (overrides.runtime?.version !== undefined) result.runtime.version = overrides.runtime.version
  for (const [key, selection] of Object.entries(overrides.components || {}) as Array<[keyof ContainerComponents, Partial<ComponentSelection>]>) {
    if (selection.enabled !== undefined) result.components[key].enabled = selection.enabled
    if (selection.version !== undefined) result.components[key].version = selection.version
  }
  if (overrides.launch) {
    for (const key of overrideLaunchBooleanKeys) {
      const value = overrides.launch[key]
      if (value !== undefined) result.launch[key] = value
    }
    if (overrides.launch.dxvkFrameRate !== undefined) result.launch.dxvkFrameRate = overrides.launch.dxvkFrameRate
    if (overrides.launch.fsrSharpness !== undefined) result.launch.fsrSharpness = overrides.launch.fsrSharpness
    if (overrides.launch.environment) result.launch.environment = { ...result.launch.environment, ...overrides.launch.environment }
  }
  validateContainer(result, GAME_OVERRIDE_FILE)
  return result
}

export function hasGameLaunchOverrides(overrides: GameOverrides): boolean {
  return Boolean(overrides.runtime || overrides.components || overrides.launch)
}

export function assertContainerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('Container name must be 1–64 characters of letters, numbers, dot, underscore, or hyphen.')
  }
}

export async function loadContainer(name: string, paths = getPaths()): Promise<ContainerConfig> {
  const file = containerFile(paths, name)
  if (!existsSync(file)) throw new Error(`Container "${name}" does not exist. Create it with: wur container create --name ${name}`)
  const raw = await readJson<ContainerConfig>(file)
  // Older container files cached installed-runtime implementation details.
  // A container is declarative: only source/version belong in its JSON. Keep
  // reading old files, but discard those derived fields before using them.
  const container: ContainerConfig = {
    ...raw,
    runtime: declaredRuntime(raw.runtime, file)
  }
  return parseWithSchema(containerConfigSchema, container, file)
}

export async function saveContainer(container: ContainerConfig, paths = getPaths()): Promise<void> {
  container.runtime = declaredRuntime(container.runtime, `container ${container.name}`)
  parseWithSchema(containerConfigSchema, container, `container ${container.name}`)
  container.updatedAt = new Date().toISOString()
  await writeJson(containerFile(paths, container.name), container)
}

/**
 * Runtime installation data (paths, IDs and kind) is discovered locally every
 * time a container is prepared. It must never become part of container.json.
 */
function declaredRuntime(value: unknown, origin: string): ContainerRuntimeRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Container runtime in ${origin} must be an object.`)
  }
  const legacy = value as Record<string, unknown>
  // Runtime metadata (path, id, kind) from older container files is derived
  // locally and deliberately discarded from the declarative reference.
  return parseWithSchema(containerRuntimeRefSchema, { source: legacy.source, version: legacy.version }, `Container runtime in ${origin}`)
}

/**
 * Resolves a partial config.json into a complete container definition. Identity
 * fields (name, prefix and timestamps) intentionally come from the folder and
 * are never accepted from the manifest, keeping the installation portable.
 */
export function resolveContainerManifest(raw: unknown, defaults: DefaultsFile): Omit<ContainerConfig, 'schemaVersion' | 'name' | 'createdAt' | 'updatedAt' | 'prefix'> {
  const manifest = parseWithSchema(containerManifestSchema, raw, 'config.json')
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) throw new Error('config.json schemaVersion must be 1.')
  const resolved = structuredClone(defaults.container)

  if (manifest.runtime !== undefined) {
    const runtime = manifest.runtime
    const source = runtime.source
    const version = runtime.version
    if (source !== undefined) {
      if (!isRuntimeSource(source)) throw new Error(`config.json.runtime.source is not a known runtime: ${source}`)
      resolved.runtime.source = source
    }
    if (version !== undefined) resolved.runtime.version = version
  }

  if (manifest.architecture !== undefined) {
    const architecture = manifest.architecture
    if (typeof architecture !== 'string' || !['win32', 'win64', 'wow64'].includes(architecture)) {
      throw new Error('config.json.architecture must be win32, win64, or wow64.')
    }
    resolved.architecture = architecture as ContainerConfig['architecture']
  }

  if (manifest.components !== undefined) {
    const components = manifest.components
    const componentNames = Object.keys(resolved.components)
    onlyKeys(components, componentNames, 'config.json.components')
    for (const [name, rawSelection] of Object.entries(components)) {
      const selection = rawSelection
      const enabled = selection.enabled
      const version = selection.version
      const target = resolved.components[name as keyof ContainerComponents]
      if (enabled !== undefined) target.enabled = enabled
      if (version !== undefined) target.version = version
    }
  }

  if (manifest.launch !== undefined) {
    const launch = manifest.launch
    const booleanKeys = ['enableEsync', 'enableFsync', 'enableMsync', 'enableWayland', 'enableHdr', 'enableWow64', 'showFps', 'fsr', 'verboseLogs'] as const
    onlyKeys(launch, [...booleanKeys, 'dxvkFrameRate', 'fsrSharpness', 'environment'], 'config.json.launch')
    for (const key of booleanKeys) {
      const value = launch[key]
      if (value !== undefined) resolved.launch[key] = value
    }
    if (launch.dxvkFrameRate !== undefined) {
      resolved.launch.dxvkFrameRate = launch.dxvkFrameRate
    }
    if (launch.fsrSharpness !== undefined) {
      resolved.launch.fsrSharpness = launch.fsrSharpness
    }
    if (launch.environment !== undefined) {
      resolved.launch.environment = { ...resolved.launch.environment, ...launch.environment }
    }
  }
  return resolved
}

export async function loadContainerManifest(name: string, defaults: DefaultsFile, paths = getPaths()): Promise<Omit<ContainerConfig, 'schemaVersion' | 'name' | 'createdAt' | 'updatedAt' | 'prefix'>> {
  const file = containerManifestFile(paths, name)
  if (!existsSync(file)) throw new Error(`Container "${name}" has no config.json. Expected: ${file}`)
  return resolveContainerManifest(await readJson<unknown>(file), defaults)
}

export function newContainer(name: string, defaults: DefaultsFile, paths: Paths): ContainerConfig {
  assertContainerName(name)
  const base = structuredClone(defaults.container)
  const now = new Date().toISOString()
  return {
    ...base,
    schemaVersion: 1,
    name,
    createdAt: now,
    updatedAt: now,
    prefix: join(containerDirectory(paths, name), 'prefix')
  }
}

export function parseRuntimeReference(input: string): { source: RuntimeSource; version: string } {
  const slash = input.indexOf('/')
  if (slash < 1 || slash === input.length - 1) {
    throw new Error('Runtime must use source/version, for example ge-proton/latest.')
  }
  const source = input.slice(0, slash)
  const version = input.slice(slash + 1)
  if (!isRuntimeSource(source)) throw new Error(`Unknown runtime source "${source}".`)
  return { source, version }
}

function validateDefaults(defaults: DefaultsFile, origin: string): void {
  parseWithSchema(defaultsFileSchema, defaults, origin)
}

function validateContainer(container: ContainerConfig, origin: string): void {
  parseWithSchema(containerConfigSchema, container, origin)
  if (!isAbsolute(container.prefix)) throw new Error(`Container prefix must be an absolute path in ${origin}`)
  assertContainerName(container.name)
}

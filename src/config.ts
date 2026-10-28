import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { ensurePaths, getPaths, readJson, writeJson } from './paths.js'
import type {
  AppConfig,
  ComponentSelection,
  ContainerConfig,
  ContainerComponents,
  ContainerRuntimeRef,
  DefaultsFile,
  LaunchOptions,
  Paths,
  RuntimeSource
} from './types.js'

export interface ContainerManifest {
  schemaVersion?: 1
  runtime?: Partial<Pick<ContainerRuntimeRef, 'source' | 'version'>>
  architecture?: ContainerConfig['architecture']
  components?: Partial<{ [Key in keyof ContainerComponents]: Partial<ComponentSelection> }>
  launch?: Partial<Omit<LaunchOptions, 'environment'>> & { environment?: Record<string, string> }
}

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
    const bundled = await readJson<DefaultsFile>(paths.defaults)
    await writeJson(paths.defaults, platformizeDefaults(bundled))
  }
  const defaults = await readJson<DefaultsFile>(paths.defaults)
  validateDefaults(defaults, paths.defaults)
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
  const config = await readJson<AppConfig>(paths.appConfig)
  if (config.schemaVersion !== 1) throw new Error(`Unsupported config schema in ${paths.appConfig}`)
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

/** The hand-authored, partial configuration consumed by `proton-cli build`. */
export function containerManifestFile(paths: Paths, name: string): string {
  return join(containerDirectory(paths, name), 'config.json')
}

export function assertContainerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('Container name must be 1–64 characters of letters, numbers, dot, underscore, or hyphen.')
  }
}

export async function loadContainer(name: string, paths = getPaths()): Promise<ContainerConfig> {
  const file = containerFile(paths, name)
  if (!existsSync(file)) throw new Error(`Container "${name}" does not exist. Create it with: proton-cli container create --name ${name}`)
  const raw = await readJson<ContainerConfig>(file)
  // Older container files cached installed-runtime implementation details.
  // A container is declarative: only source/version belong in its JSON. Keep
  // reading old files, but discard those derived fields before using them.
  const container: ContainerConfig = {
    ...raw,
    runtime: declaredRuntime(raw.runtime, file)
  }
  validateContainer(container, file)
  return container
}

export async function saveContainer(container: ContainerConfig, paths = getPaths()): Promise<void> {
  container.runtime = declaredRuntime(container.runtime, `container ${container.name}`)
  validateContainer(container, `container ${container.name}`)
  container.updatedAt = new Date().toISOString()
  await writeJson(containerFile(paths, container.name), container)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field "${key}".`)
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string.`)
  return value
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`)
  return value
}

/**
 * Runtime installation data (paths, IDs and kind) is discovered locally every
 * time a container is prepared. It must never become part of container.json.
 */
function declaredRuntime(value: unknown, origin: string): ContainerRuntimeRef {
  const runtime = objectValue(value, `Container runtime in ${origin}`)
  const source = runtime.source
  const version = runtime.version
  if (typeof source !== 'string' || !isRuntimeSource(source) || typeof version !== 'string' || !version) {
    throw new Error(`Container runtime is invalid in ${origin}`)
  }
  return { source, version }
}

/**
 * Resolves a partial config.json into a complete container definition. Identity
 * fields (name, prefix and timestamps) intentionally come from the folder and
 * are never accepted from the manifest, keeping the installation portable.
 */
export function resolveContainerManifest(raw: unknown, defaults: DefaultsFile): Omit<ContainerConfig, 'schemaVersion' | 'name' | 'createdAt' | 'updatedAt' | 'prefix'> {
  const manifest = objectValue(raw, 'config.json')
  onlyKeys(manifest, ['schemaVersion', 'runtime', 'architecture', 'components', 'launch'], 'config.json')
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    throw new Error('config.json schemaVersion must be 1.')
  }
  const resolved = structuredClone(defaults.container)

  if (manifest.runtime !== undefined) {
    const runtime = objectValue(manifest.runtime, 'config.json.runtime')
    onlyKeys(runtime, ['source', 'version'], 'config.json.runtime')
    const source = optionalString(runtime.source, 'config.json.runtime.source')
    const version = optionalString(runtime.version, 'config.json.runtime.version')
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
    const components = objectValue(manifest.components, 'config.json.components')
    const componentNames = Object.keys(resolved.components)
    onlyKeys(components, componentNames, 'config.json.components')
    for (const [name, rawSelection] of Object.entries(components)) {
      const selection = objectValue(rawSelection, `config.json.components.${name}`)
      onlyKeys(selection, ['enabled', 'version'], `config.json.components.${name}`)
      const enabled = optionalBoolean(selection.enabled, `config.json.components.${name}.enabled`)
      const version = optionalString(selection.version, `config.json.components.${name}.version`)
      const target = resolved.components[name as keyof ContainerComponents]
      if (enabled !== undefined) target.enabled = enabled
      if (version !== undefined) target.version = version
    }
  }

  if (manifest.launch !== undefined) {
    const launch = objectValue(manifest.launch, 'config.json.launch')
    const booleanKeys = ['enableEsync', 'enableFsync', 'enableMsync', 'enableWayland', 'enableHdr', 'enableWow64', 'showFps', 'fsr', 'verboseLogs'] as const
    onlyKeys(launch, [...booleanKeys, 'dxvkFrameRate', 'fsrSharpness', 'environment'], 'config.json.launch')
    for (const key of booleanKeys) {
      const value = optionalBoolean(launch[key], `config.json.launch.${key}`)
      if (value !== undefined) resolved.launch[key] = value
    }
    if (launch.dxvkFrameRate !== undefined) {
      if (launch.dxvkFrameRate !== null && (typeof launch.dxvkFrameRate !== 'number' || !Number.isFinite(launch.dxvkFrameRate))) {
        throw new Error('config.json.launch.dxvkFrameRate must be a number or null.')
      }
      resolved.launch.dxvkFrameRate = launch.dxvkFrameRate
    }
    if (launch.fsrSharpness !== undefined) {
      if (typeof launch.fsrSharpness !== 'number' || !Number.isFinite(launch.fsrSharpness)) {
        throw new Error('config.json.launch.fsrSharpness must be a number.')
      }
      resolved.launch.fsrSharpness = launch.fsrSharpness
    }
    if (launch.environment !== undefined) {
      const environment = objectValue(launch.environment, 'config.json.launch.environment')
      for (const [key, value] of Object.entries(environment)) {
        if (typeof value !== 'string') throw new Error(`config.json.launch.environment.${key} must be a string.`)
      }
      resolved.launch.environment = { ...resolved.launch.environment, ...environment as Record<string, string> }
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

export function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  if (!parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`Invalid JSON path "${path}".`)
  }
  let cursor: Record<string, unknown> = target
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts.at(-1)!] = value
}

export function parseSetExpression(expression: string): { path: string; value: unknown } {
  const equals = expression.indexOf('=')
  if (equals < 1) throw new Error(`Expected path=value, received "${expression}".`)
  return { path: expression.slice(0, equals), value: parseJsonValue(expression.slice(equals + 1)) }
}

function validateDefaults(defaults: DefaultsFile, origin: string): void {
  if (defaults.schemaVersion !== 1 || !defaults.container) throw new Error(`Unsupported defaults schema in ${origin}`)
  validateContainer({
    ...structuredClone(defaults.container),
    schemaVersion: 1,
    name: 'validation',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    prefix: '/tmp/validation'
  }, origin)
}

function validateContainer(container: ContainerConfig, origin: string): void {
  if (container.schemaVersion !== 1) throw new Error(`Unsupported container schema in ${origin}`)
  assertContainerName(container.name)
  if (!isAbsolute(container.prefix)) throw new Error(`Container prefix must be an absolute path in ${origin}`)
  declaredRuntime(container.runtime, origin)
  const c = container.components
  if (!c || ![c.dxvk, c.dxvkNvapi, c.vkd3d, c.eacRuntime, c.battleyeRuntime].every((component) => component && typeof component.enabled === 'boolean' && typeof component.version === 'string')) {
    throw new Error(`Container components are invalid in ${origin}`)
  }
  if (!container.launch || typeof container.launch.environment !== 'object' || container.launch.environment === null) {
    throw new Error(`Container launch settings are invalid in ${origin}`)
  }
}

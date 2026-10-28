import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  assertContainerName,
  containerDirectory,
  containerFile,
  containerManifestFile,
  loadAppConfig,
  loadContainer,
  loadDefaults,
  loadContainerManifest,
  newContainer,
  saveAppConfig,
  saveContainer
} from './config.js'
import { applyDllComponent, findInstalledComponent, installComponent } from './components.js'
import { initializePrefix, runRuntime, stopWineServer } from './launch.js'
import { ensurePaths, getPaths } from './paths.js'
import { findInstalledRuntime, installRuntime } from './runtime.js'
import { canRunRuntimeOnThisSystem, runtimeSources, sourcesForPlatform } from './sources.js'
import type { ContainerConfig, DefaultsFile, InstalledRuntime, Paths } from './types.js'

export async function listContainers(paths = getPaths()): Promise<ContainerConfig[]> {
  await ensurePaths(paths)
  const containers: ContainerConfig[] = []
  for (const entry of await readdir(paths.containers, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(containerFile(paths, entry.name))) continue
    try { containers.push(await loadContainer(entry.name, paths)) } catch { /* omit malformed external folders */ }
  }
  return containers.sort((a, b) => a.name.localeCompare(b.name))
}

async function resolvedRuntime(container: ContainerConfig, paths: Paths): Promise<InstalledRuntime> {
  const { source, version } = container.runtime
  const installed = await findInstalledRuntime(source, version, paths)
  if (installed) return installed
  try {
    return await installRuntime(source, version, false, paths)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Runtime ${source}/${version} is not installed and automatic installation failed: ${message}`)
  }
}

async function registerNativeDlls(container: ContainerConfig, runtime: InstalledRuntime, dlls: string[]): Promise<void> {
  for (const dll of dlls) {
    const result = await runRuntime(container, runtime, [
      'reg', 'add', 'HKEY_CURRENT_USER\\Software\\Wine\\DllOverrides',
      '/v', dll.replace(/\.dll$/i, ''), '/d', 'native,builtin', '/f'
    ], { protonVerb: 'run' })
    if (result.code !== 0) throw new Error(`Could not register ${dll} in ${container.name} (status ${result.code})`)
  }
}

async function prepareWineComponents(container: ContainerConfig, runtime: InstalledRuntime, paths: Paths): Promise<void> {
  if (runtime.kind === 'proton') {
    // Proton brings its own DXVK and VKD3D. Copying another version over it is unsafe.
    return
  }
  if (runtime.kind === 'toolkit') {
    // Heroic avoids changing GPTK's D3DMetal setup for the same reason.
    return
  }
  const requested: Array<{ selection: keyof ContainerConfig['components']; name: 'dxvk' | 'dxvk-nvapi' | 'vkd3d' | 'dxvk-macos' }> = [
    { selection: 'dxvk', name: process.platform === 'darwin' ? 'dxvk-macos' : 'dxvk' },
    { selection: 'dxvkNvapi', name: 'dxvk-nvapi' },
    { selection: 'vkd3d', name: 'vkd3d' }
  ]
  for (const item of requested) {
    const selected = container.components[item.selection]
    if (!selected.enabled) continue
    if (process.platform === 'darwin' && item.name !== 'dxvk-macos') continue
    const installed = await findInstalledComponent(item.name, selected.version, paths)
    const component = installed || await installComponent(item.name, selected.version, false, paths)
    const marker = join(container.prefix, `current_${item.name}`)
    if (existsSync(marker) && (await readFile(marker, 'utf8')).trim() === component.version) continue
    const dlls = await applyDllComponent(component, container.prefix)
    await registerNativeDlls(container, runtime, dlls)
    await writeFile(marker, `${component.version}\n`, 'utf8')
  }
}

async function prepareRuntimeComponents(container: ContainerConfig, paths: Paths): Promise<void> {
  const requested: Array<{ enabled: boolean; version: string; name: 'eac-runtime' | 'battleye-runtime' }> = [
    { ...container.components.eacRuntime, name: 'eac-runtime' },
    { ...container.components.battleyeRuntime, name: 'battleye-runtime' }
  ]
  if (process.platform !== 'linux') return
  for (const component of requested) {
    if (component.enabled) {
      const installed = await findInstalledComponent(component.name, component.version, paths)
      if (!installed) await installComponent(component.name, component.version, false, paths)
    }
  }
}

export async function prepareContainer(container: ContainerConfig, paths = getPaths()): Promise<{ container: ContainerConfig; runtime: InstalledRuntime }> {
  if (!canRunRuntimeOnThisSystem(container.runtime.source)) {
    const alternatives = sourcesForPlatform().filter((source) => canRunRuntimeOnThisSystem(source.id)).map((source) => source.id).join(', ')
    throw new Error(`${runtimeSources[container.runtime.source].label} cannot run on ${process.platform}/${process.arch}. Use one of: ${alternatives || 'no supported runtime detected'}. Run "proton-cli suggest" for guidance.`)
  }
  const runtime = await resolvedRuntime(container, paths)
  await saveContainer(container, paths)
  await initializePrefix(container, runtime)
  await prepareWineComponents(container, runtime, paths)
  await prepareRuntimeComponents(container, paths)
  await stopWineServer(container, runtime)
  return { container, runtime }
}

export async function createContainer(
  name: string,
  options: { defaults?: DefaultsFile; initialize?: boolean; mutate?: (container: ContainerConfig) => void } = {},
  paths = getPaths()
): Promise<ContainerConfig> {
  await ensurePaths(paths)
  if (existsSync(containerFile(paths, name))) throw new Error(`Container "${name}" already exists.`)
  const defaults = options.defaults || await loadDefaults(paths)
  const container = newContainer(name, defaults, paths)
  options.mutate?.(container)
  await mkdir(dirname(containerFile(paths, name)), { recursive: true })
  await saveContainer(container, paths)
  if (options.initialize !== false) await prepareContainer(container, paths)
  const config = await loadAppConfig(paths)
  if (!config.defaultContainer) {
    config.defaultContainer = name
    await saveAppConfig(config, paths)
  }
  return container
}

export async function defaultContainer(paths = getPaths()): Promise<string | undefined> {
  return (await loadAppConfig(paths)).defaultContainer
}

export async function setDefaultContainer(name: string, paths = getPaths()): Promise<void> {
  await loadContainer(name, paths)
  const config = await loadAppConfig(paths)
  config.defaultContainer = name
  await saveAppConfig(config, paths)
}

/** Permanently removes a container and its self-contained Wine prefix. */
export async function removeContainer(name: string, paths = getPaths()): Promise<{ name: string; path: string; clearedDefault: boolean }> {
  // Loading first validates the name and ensures we only remove a managed
  // container that actually exists.
  await loadContainer(name, paths)
  const directory = containerDirectory(paths, name)
  await rm(directory, { recursive: true, force: false })
  const config = await loadAppConfig(paths)
  const clearedDefault = config.defaultContainer === name
  if (clearedDefault) {
    delete config.defaultContainer
    await saveAppConfig(config, paths)
  }
  return { name, path: directory, clearedDefault }
}

/** Lists folders that contain a declarative config.json manifest. */
export async function listBuildableContainers(paths = getPaths()): Promise<string[]> {
  await ensurePaths(paths)
  const names: string[] = []
  for (const entry of await readdir(paths.containers, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      assertContainerName(entry.name)
      if (existsSync(containerManifestFile(paths, entry.name))) names.push(entry.name)
    } catch {
      // Ignore unrelated folders rather than broadening the scope of build.
    }
  }
  return names.sort((left, right) => left.localeCompare(right))
}

/**
 * Builds a full container.json from containers/<name>/config.json and, by
 * default, initializes the Wine prefix and its selected components.
 */
export async function buildContainer(name: string, options: { initialize?: boolean } = {}, paths = getPaths()): Promise<ContainerConfig> {
  assertContainerName(name)
  await ensurePaths(paths)
  const defaults = await loadDefaults(paths)
  const definition = await loadContainerManifest(name, defaults, paths)
  const existing = existsSync(containerFile(paths, name)) ? await loadContainer(name, paths) : undefined
  const now = new Date().toISOString()
  const container: ContainerConfig = {
    ...definition,
    schemaVersion: 1,
    name,
    prefix: join(containerDirectory(paths, name), 'prefix'),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  }
  await mkdir(containerDirectory(paths, name), { recursive: true })
  await saveContainer(container, paths)
  const built = options.initialize === false
    ? container
    : (await prepareContainer(container, paths)).container
  const appConfig = await loadAppConfig(paths)
  if (!appConfig.defaultContainer) {
    appConfig.defaultContainer = name
    await saveAppConfig(appConfig, paths)
  }
  return built
}

export async function ensureDefaultContainer(paths = getPaths()): Promise<ContainerConfig> {
  const configured = await defaultContainer(paths)
  if (configured) return await loadContainer(configured, paths)
  return await createContainer('default', { initialize: true }, paths)
}

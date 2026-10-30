import type { Command } from 'commander'
import { isRuntimeSource } from '../config.js'
import { componentNames } from '../sources.js'
import type {
  ComponentName,
  ContainerConfig,
  ContainerNameOptions,
  GlobalOptions,
  RuntimeSource
} from '../types/index.js'

export function commandUsesJson(command: Command): boolean {
  return Boolean(command.optsWithGlobals<GlobalOptions>().json)
}

export function requireContainerName(argument: string | undefined, options: ContainerNameOptions): string {
  const name = options.name || argument
  if (!name) throw new Error('A container name is required. Use --name NAME.')
  return name
}

export function parseRuntimeSource(value: string): RuntimeSource {
  if (!isRuntimeSource(value)) throw new Error(`Unknown runtime source "${value}".`)
  return value
}

export function parseComponentName(value: string): ComponentName {
  if (!componentNames.includes(value as ComponentName)) throw new Error(`Unknown component "${value}".`)
  return value as ComponentName
}

export function containerComponentKey(name: string): keyof ContainerConfig['components'] {
  const map: Record<string, keyof ContainerConfig['components']> = {
    dxvk: 'dxvk',
    'dxvk-nvapi': 'dxvkNvapi',
    dxvkNvapi: 'dxvkNvapi',
    vkd3d: 'vkd3d',
    'eac-runtime': 'eacRuntime',
    eacRuntime: 'eacRuntime',
    'battleye-runtime': 'battleyeRuntime',
    battleyeRuntime: 'battleyeRuntime'
  }
  if (!map[name]) throw new Error(`Unknown container component "${name}".`)
  return map[name]
}

export function recommendedComponentNames(
  container: Pick<ContainerConfig, 'components'>
): Array<{ name: ComponentName; version: string }> {
  const selected: Array<{ name: ComponentName; version: string }> = []
  if (container.components.dxvk.enabled) {
    selected.push({
      name: process.platform === 'darwin' ? 'dxvk-macos' : 'dxvk',
      version: container.components.dxvk.version
    })
  }
  if (process.platform === 'linux') {
    if (container.components.dxvkNvapi.enabled)
      selected.push({ name: 'dxvk-nvapi', version: container.components.dxvkNvapi.version })
    if (container.components.vkd3d.enabled)
      selected.push({ name: 'vkd3d', version: container.components.vkd3d.version })
    if (container.components.eacRuntime.enabled)
      selected.push({ name: 'eac-runtime', version: container.components.eacRuntime.version })
    if (container.components.battleyeRuntime.enabled)
      selected.push({ name: 'battleye-runtime', version: container.components.battleyeRuntime.version })
  }
  return selected
}

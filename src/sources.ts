import type { ComponentName, RuntimeKind, RuntimeSource } from './types.js'

export interface RuntimeSourceInfo {
  id: RuntimeSource
  label: string
  apiUrl: string
  kind: RuntimeKind
  platforms: NodeJS.Platform[]
  stagingOnly?: boolean
}

export const runtimeSources: Record<RuntimeSource, RuntimeSourceInfo> = {
  'ge-proton': {
    id: 'ge-proton',
    label: 'GE-Proton',
    apiUrl: 'https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases',
    kind: 'proton',
    platforms: ['linux']
  },
  proton: {
    id: 'proton',
    label: 'Valve Proton',
    apiUrl: 'https://api.github.com/repos/ValveSoftware/Proton/releases',
    kind: 'proton',
    platforms: ['linux']
  },
  'proton-cachyos': {
    id: 'proton-cachyos',
    label: 'Proton-CachyOS',
    apiUrl: 'https://api.github.com/repos/CachyOS/proton-cachyos/releases',
    kind: 'proton',
    platforms: ['linux']
  },
  'wine-lutris': {
    id: 'wine-lutris',
    label: 'Wine-Lutris',
    apiUrl: 'https://api.github.com/repos/lutris/wine/releases',
    kind: 'wine',
    platforms: ['linux']
  },
  'wine-crossover': {
    id: 'wine-crossover',
    label: 'Wine-CrossOver',
    apiUrl: 'https://api.github.com/repos/Heroic-Games-Launcher/wine-crossover/releases',
    kind: 'crossover',
    platforms: ['darwin']
  },
  'wine-staging-macos': {
    id: 'wine-staging-macos',
    label: 'Wine-Staging macOS',
    apiUrl: 'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases',
    kind: 'wine',
    platforms: ['darwin'],
    stagingOnly: true
  },
  'game-porting-toolkit': {
    id: 'game-porting-toolkit',
    label: 'Game Porting Toolkit',
    apiUrl: 'https://api.github.com/repos/Gcenx/game-porting-toolkit/releases',
    kind: 'toolkit',
    platforms: ['darwin']
  }
}

export const componentNames: ComponentName[] = [
  'dxvk',
  'dxvk-nvapi',
  'vkd3d',
  'dxvk-macos',
  'dxmt',
  'eac-runtime',
  'battleye-runtime',
  'umu'
]

export interface ComponentRecommendation {
  name: ComponentName
  recommended: boolean
  note: string
}

export function sourcesForPlatform(includeAll = false): RuntimeSourceInfo[] {
  return Object.values(runtimeSources).filter((source) => includeAll || canRunRuntimeOnThisSystem(source.id))
}

export function canRunRuntimeOnThisSystem(source: RuntimeSource): boolean {
  if (!runtimeSources[source].platforms.includes(process.platform)) return false
  // Heroic only offers GPTK on Apple Silicon Macs. It also requires macOS Sonoma or newer.
  if (source === 'game-porting-toolkit' && process.arch !== 'arm64') return false
  return true
}

export function compatibleComponentRecommendations(includeAll = false): ComponentRecommendation[] {
  const linux: ComponentRecommendation[] = [
    { name: 'dxvk', recommended: true, note: 'Direct3D 9/10/11 for Wine prefixes' },
    { name: 'vkd3d', recommended: true, note: 'Direct3D 12 for Wine prefixes' },
    { name: 'dxvk-nvapi', recommended: false, note: 'Enable when using a supported NVIDIA driver' },
    { name: 'eac-runtime', recommended: true, note: 'Easy Anti-Cheat runtime' },
    { name: 'battleye-runtime', recommended: true, note: 'BattlEye runtime' },
    { name: 'umu', recommended: false, note: 'Optional Steam Runtime launcher integration' }
  ]
  const mac: ComponentRecommendation[] = [
    { name: 'dxvk-macos', recommended: true, note: 'DXVK for Wine Staging/CrossOver prefixes; GPTK is left untouched' },
    { name: 'dxmt', recommended: false, note: 'Optional DXMT files for a Wine Staging variant on Apple Silicon' }
  ]
  const current = process.platform === 'linux' ? linux : process.platform === 'darwin' ? mac : []
  if (!includeAll) return current
  return [...linux, ...mac.filter((candidate) => !linux.some((existing) => existing.name === candidate.name))]
}

export function isArchiveAsset(name: string): boolean {
  return /\.tar\.(gz|xz|zst)$/i.test(name)
}

export function assetMatchesArchitecture(source: RuntimeSource, assetName: string): boolean {
  if (!isArchiveAsset(assetName)) return false
  if (source === 'ge-proton') {
    const armAsset = /-(aarch64|arm64)\.tar\.(gz|xz|zst)$/i.test(assetName)
    return process.arch === 'arm64' ? armAsset : !armAsset
  }
  if (source === 'proton-cachyos') {
    const desired = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : ''
    return Boolean(desired) && assetName.endsWith(`-${desired}.tar.xz`)
  }
  return true
}

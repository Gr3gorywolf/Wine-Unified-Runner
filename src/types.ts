export type RuntimeSource =
  | 'ge-proton'
  | 'proton'
  | 'proton-cachyos'
  | 'wine-lutris'
  | 'wine-crossover'
  | 'wine-staging-macos'
  | 'game-porting-toolkit'

export type RuntimeKind = 'proton' | 'wine' | 'toolkit' | 'crossover'

export interface RuntimeRelease {
  source: RuntimeSource
  version: string
  date: string
  download: string
  size: number
  checksum?: string
  notesUrl: string
  latest?: boolean
}

export interface InstalledRuntime {
  id: string
  source: RuntimeSource
  version: string
  kind: RuntimeKind
  path: string
  bin: string
  wineserver?: string
  installedAt: string
  release: Pick<RuntimeRelease, 'date' | 'download' | 'notesUrl'>
}

export type ComponentName =
  | 'dxvk'
  | 'dxvk-nvapi'
  | 'vkd3d'
  | 'dxvk-macos'
  | 'dxmt'
  | 'eac-runtime'
  | 'battleye-runtime'
  | 'umu'

export interface ComponentRelease {
  name: ComponentName
  version: string
  date: string
  download: string
  size: number
  notesUrl: string
  stripComponents: number
}

export interface InstalledComponent {
  name: ComponentName
  version: string
  path: string
  installedAt: string
  release: Pick<ComponentRelease, 'date' | 'download' | 'notesUrl'>
}

export interface ComponentSelection {
  enabled: boolean
  version: string
}

export interface ContainerComponents {
  dxvk: ComponentSelection
  dxvkNvapi: ComponentSelection
  vkd3d: ComponentSelection
  eacRuntime: ComponentSelection
  battleyeRuntime: ComponentSelection
}

export interface LaunchOptions {
  enableEsync: boolean
  enableFsync: boolean
  enableMsync: boolean
  enableWayland: boolean
  enableHdr: boolean
  enableWow64: boolean
  showFps: boolean
  dxvkFrameRate: number | null
  fsr: boolean
  fsrSharpness: number
  verboseLogs: boolean
  environment: Record<string, string>
}

export interface ContainerRuntimeRef {
  source: RuntimeSource
  version: string
}

export interface ContainerConfig {
  schemaVersion: 1
  name: string
  createdAt: string
  updatedAt: string
  prefix: string
  architecture: 'win32' | 'win64' | 'wow64'
  runtime: ContainerRuntimeRef
  components: ContainerComponents
  launch: LaunchOptions
}

export interface DefaultsFile {
  schemaVersion: 1
  container: Omit<ContainerConfig, 'schemaVersion' | 'name' | 'createdAt' | 'updatedAt' | 'prefix'>
}

export interface AppConfig {
  schemaVersion: 1
  defaultContainer?: string
}

export interface Paths {
  root: string
  containers: string
  runtimes: string
  components: string
  downloads: string
  appConfig: string
  defaults: string
  bundledDefaults: string
}

export interface SpawnResult {
  code: number | null
  signal: NodeJS.Signals | null
}

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

export interface InstallOptions {
  /** Receives an integer percentage from 0 through 100. */
  onProgress?: (progress: number) => void
  /** Suppresses human-oriented status output for machine-readable callers. */
  quiet?: boolean
}

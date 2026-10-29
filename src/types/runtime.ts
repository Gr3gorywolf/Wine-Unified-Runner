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

export interface ContainerRuntimeRef {
  source: RuntimeSource
  version: string
}

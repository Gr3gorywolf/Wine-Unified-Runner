import type { ComponentSelection, ContainerComponents } from './components.js'
import type { ContainerRuntimeRef } from './runtime.js'

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

export interface ContainerPrepareProgress {
  name: string
  progress: number
  message: string
}

export interface PrepareContainerOptions {
  /** Do not rewrite container.json when preparing an in-memory launch override. */
  persist?: boolean
  /** Suppress the installers' own output when progress is handled by a caller. */
  quiet?: boolean
  /** Reports download and installation progress for every missing dependency. */
  onProgress?: (event: ContainerPrepareProgress) => void
}

export interface DefaultsFile {
  schemaVersion: 1
  container: Omit<ContainerConfig, 'schemaVersion' | 'name' | 'createdAt' | 'updatedAt' | 'prefix'>
}

export interface AppConfig {
  schemaVersion: 1
  defaultContainer?: string
  home?: string
}

export interface GameOverrides {
  containerName?: string
  components?: Partial<{ [Key in keyof ContainerComponents]: Partial<ComponentSelection> }>
  launch?: Partial<Omit<LaunchOptions, 'environment'>> & { environment?: Record<string, string> }
}

export interface ContainerManifest {
  schemaVersion?: 1
  runtime?: Partial<Pick<ContainerRuntimeRef, 'source' | 'version'>>
  architecture?: ContainerConfig['architecture']
  components?: Partial<{ [Key in keyof ContainerComponents]: Partial<ComponentSelection> }>
  launch?: Partial<Omit<LaunchOptions, 'environment'>> & { environment?: Record<string, string> }
}

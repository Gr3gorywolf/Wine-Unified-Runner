export interface GlobalOptions {
  json?: boolean
}

export interface RuntimeListOptions {
  remote?: boolean
  available?: boolean
  all?: boolean
  source?: string
  limit: number
}

export interface ForceOptions {
  force?: boolean
}

export interface RecommendedOptions extends ForceOptions {
  dryRun?: boolean
}

export interface BuildOptions {
  name?: string
}

export interface ComponentListOptions {
  remote?: boolean
  available?: boolean
  all?: boolean
  name?: string
  limit: number
}

export interface ContainerNameOptions {
  name?: string
}

export interface ContainerExecOptions extends ContainerNameOptions {
  cwd?: string
}

export interface ContainerCreateOptions extends ContainerNameOptions {
  runtime?: string
  component: string[]
  set: string[]
  initialize: boolean
}

export interface SettingsOptions {
  set: string[]
}

export interface OverrideSetOptions {
  val: string[]
}

export interface ContainerConfigureOptions extends ContainerNameOptions, SettingsOptions {}

export interface RunOptions {
  container?: string
  cwd?: string
}

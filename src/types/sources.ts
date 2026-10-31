import type { ComponentName } from './components.js'
import type { RuntimeKind, RuntimeSource } from './runtime.js'

export interface RuntimeSourceInfo {
  id: RuntimeSource
  label: string
  apiUrl: string
  kind: RuntimeKind
  platforms: NodeJS.Platform[]
  /** Components WUR must never inject or override for this runtime. */
  ignoredComponents: ComponentName[]
  stagingOnly?: boolean
}

export interface ComponentRecommendation {
  name: ComponentName
  recommended: boolean
  note: string
}

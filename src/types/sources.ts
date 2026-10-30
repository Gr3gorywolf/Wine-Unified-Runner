import type { ComponentName } from './components.js'
import type { RuntimeKind, RuntimeSource } from './runtime.js'

export interface RuntimeSourceInfo {
  id: RuntimeSource
  label: string
  apiUrl: string
  kind: RuntimeKind
  platforms: NodeJS.Platform[]
  stagingOnly?: boolean
}

export interface ComponentRecommendation {
  name: ComponentName
  recommended: boolean
  note: string
}

import ini from 'ini'
import { gameOverrideIniSchema } from '../schemas/index.js'
import type { GameOverrides } from '../types/index.js'

export const GAME_OVERRIDE_FILE = 'wur-overrides.ini'
export const overrideLaunchBooleanKeys = [
  'enableEsync', 'enableFsync', 'enableMsync', 'enableWayland', 'enableHdr',
  'enableWow64', 'showFps', 'fsr', 'verboseLogs'
] as const

/**
 * Parses a game's editable INI sidecar. The schema deliberately strips
 * unsupported sections, keys, and malformed values so a typo cannot prevent
 * an otherwise valid game launch.
 */
export function parseGameOverrides(contents: string, _origin?: string): GameOverrides {
  try {
    return gameOverrideIniSchema.parse(ini.parse(contents))
  } catch {
    // ini.parse is normally tolerant too; this guard treats malformed input as
    // an empty override set rather than making `wur run` unavailable.
    return {}
  }
}

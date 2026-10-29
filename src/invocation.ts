import { statSync } from 'node:fs'
import { resolve } from 'node:path'

// Windows' default PATHEXT extensions, plus the additional executable types
// recognized by the Windows Shell PathIsExe API (.pif, .scf, and .scr).
// Custom file associations deliberately require the explicit `run` command:
// Wine cannot reliably resolve associations configured on another Windows PC.
const windowsExecutableSuffix = /\.(?:com|exe|bat|cmd|vbs|vbe|js|jse|wsf|wsh|msc|pif|scf|scr)$/iu

/** True only for an existing regular Windows-launchable file. */
export function isExecutableFallback(value: string | undefined): boolean {
  if (!value || !windowsExecutableSuffix.test(value)) return false
  try {
    return statSync(resolve(value)).isFile()
  } catch {
    return false
  }
}

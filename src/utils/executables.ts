import { statSync } from 'node:fs'
import { resolve } from 'node:path'

// Windows' default PATHEXT extensions, plus shell launchable script types.
const windowsExecutableSuffix = /\.(?:com|exe|bat|cmd|vbs|vbe|js|jse|wsf|wsh|msc|pif|scf|scr)$/iu

export function isExecutableFallback(value: string | undefined): boolean {
  if (!value || !windowsExecutableSuffix.test(value)) return false
  try {
    return statSync(resolve(value)).isFile()
  } catch {
    return false
  }
}

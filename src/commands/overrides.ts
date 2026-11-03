import { resolve } from 'node:path'
import { removeGameOverrides, setGameOverrides, showGameOverrides } from '../services/config.js'
import { getPaths } from '../services/paths.js'
import { isExecutableFallback } from '../utils/executables.js'
import { output } from '../utils/output.js'

function validExecutable(executable: string): string {
  const resolved = resolve(executable)
  if (!isExecutableFallback(resolved)) {
    throw new Error(`"${executable}" is not an existing Windows-launchable executable.`)
  }
  return resolved
}

/** Shows only an existing game's overrides; it intentionally never creates a sidecar. */
export async function showExecutableOverrides(executable: string): Promise<void> {
  output(await showGameOverrides(validExecutable(executable)), true)
}

/** Creates the override template as needed, then writes the supplied --val entries. */
export async function setExecutableOverrides(executable: string, values: string[]): Promise<void> {
  output(await setGameOverrides(validExecutable(executable), values, getPaths()), true)
}

/** Deletes the executable's sidecar without touching the executable itself. */
export async function deleteExecutableOverrides(executable: string): Promise<void> {
  output(await removeGameOverrides(validExecutable(executable)), true)
}

import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { loadAppConfig, saveAppConfig } from '../services/config.js'
import { getInstallationPaths, getPaths } from '../services/paths.js'
import { output } from '../utils/output.js'

export async function showHome(json: boolean): Promise<void> {
  output({ home: getPaths().root }, json)
}

export async function setHome(directory: string, json: boolean): Promise<void> {
  const home = resolve(directory)
  let details: Awaited<ReturnType<typeof stat>>
  try {
    details = await stat(home)
  } catch {
    throw new Error(`Home directory does not exist: ${home}`)
  }
  if (!details.isDirectory()) throw new Error(`Home path is not a directory: ${home}`)
  try {
    await access(home, constants.W_OK)
  } catch {
    throw new Error(`Home directory is not writable: ${home}`)
  }

  // This config remains beside the executable so the selected location is
  // available before WUR resolves the rest of its state paths on the next run.
  const installationPaths = getInstallationPaths()
  const config = await loadAppConfig(installationPaths)
  config.home = home
  await saveAppConfig(config, installationPaths)
  output({ home }, json)
}

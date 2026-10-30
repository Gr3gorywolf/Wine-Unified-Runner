import {
  installComponent,
  listComponentReleases,
  listInstalledComponents,
  removeComponent
} from '../services/components.js'
import { getPaths } from '../services/paths.js'
import { compatibleComponentRecommendations } from '../services/sources.js'
import type { ComponentListOptions, ForceOptions } from '../types/index.js'
import { parseComponentName } from '../utils/cli.js'
import { formatBytes, installProgressReporter, output } from '../utils/output.js'

export async function listComponents(options: ComponentListOptions, json: boolean): Promise<void> {
  const remote = Boolean(options.remote || options.available)
  const name = options.name ? parseComponentName(options.name) : undefined
  if (!remote) {
    output(await listInstalledComponents(getPaths()), json)
    return
  }
  const recommendations = compatibleComponentRecommendations(Boolean(options.all))
  const releases = await listComponentReleases(name, options.limit, Boolean(options.all))
  output(
    releases.map((release) => ({
      name: release.name,
      version: release.version,
      date: release.date,
      size: formatBytes(release.size),
      recommended: recommendations.find((component) => component.name === release.name)?.recommended ?? false
    })),
    json
  )
}

export async function installSelectedComponent(
  nameValue: string,
  version = 'latest',
  options: ForceOptions,
  json: boolean
): Promise<void> {
  const name = parseComponentName(nameValue)
  const installed = await installComponent(
    name,
    version,
    Boolean(options.force),
    getPaths(),
    json ? { quiet: true, onProgress: installProgressReporter(name) } : undefined
  )
  if (!json) output(installed, false)
}

export async function removeSelectedComponent(nameValue: string, version = 'latest', json: boolean): Promise<void> {
  output({ removed: true, ...(await removeComponent(parseComponentName(nameValue), version, getPaths())) }, json)
}

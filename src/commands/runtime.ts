import { defaultSourceForPlatform } from '../services/config.js'
import { getPaths } from '../services/paths.js'
import { installRuntime, listInstalledRuntimes, listReleases, removeRuntime } from '../services/runtime.js'
import { canRunRuntimeOnThisSystem, sourcesForPlatform } from '../services/sources.js'
import type { ForceOptions, RuntimeListOptions } from '../types/index.js'
import { parseRuntimeSource } from '../utils/cli.js'
import { formatBytes, installProgressReporter, output } from '../utils/output.js'

export async function listRuntimes(options: RuntimeListOptions, json: boolean): Promise<void> {
  const paths = getPaths()
  const remote = Boolean(options.remote || options.available)
  const source = options.source ? parseRuntimeSource(options.source) : undefined
  if (!remote) {
    const installed = await listInstalledRuntimes(paths)
    output(source ? installed.filter((runtime) => runtime.source === source) : installed, json)
    return
  }
  if (source && !options.all && !canRunRuntimeOnThisSystem(source)) {
    throw new Error(
      `Runtime source "${source}" is not compatible with ${process.platform}/${process.arch}. Use --all only to inspect cross-platform releases.`
    )
  }
  const releases = await listReleases(source, options.limit, Boolean(options.all))
  output(
    releases.map((release) => ({
      source: release.source,
      version: release.version,
      date: release.date,
      size: formatBytes(release.size),
      latest: Boolean(release.latest),
      recommended: release.source === defaultSourceForPlatform()
    })),
    json
  )
}

export async function installSelectedRuntime(
  sourceValue: string | undefined,
  version = 'latest',
  options: ForceOptions,
  json: boolean
): Promise<void> {
  const source = parseRuntimeSource(sourceValue || defaultSourceForPlatform())
  if (!canRunRuntimeOnThisSystem(source)) {
    const alternatives = sourcesForPlatform()
      .map((candidate) => candidate.id)
      .join(', ')
    throw new Error(
      `Runtime source "${source}" cannot run on ${process.platform}/${process.arch}. Use one of: ${alternatives || 'no supported runtime detected'}.`
    )
  }
  const installed = await installRuntime(
    source,
    version,
    Boolean(options.force),
    getPaths(),
    json ? { quiet: true, onProgress: installProgressReporter(source) } : undefined
  )
  if (!json) output(installed, false)
}

export async function removeSelectedRuntime(sourceValue: string, version = 'latest', json: boolean): Promise<void> {
  output({ removed: true, ...(await removeRuntime(parseRuntimeSource(sourceValue), version, getPaths())) }, json)
}

import { installComponent } from '../services/components.js'
import { defaultSourceForPlatform, loadDefaults } from '../services/config.js'
import { getPaths } from '../services/paths.js'
import { installRuntime } from '../services/runtime.js'
import {
  canRunRuntimeOnThisSystem,
  compatibleComponentRecommendations,
  sourcesForPlatform
} from '../services/sources.js'
import type { RecommendedOptions } from '../types/index.js'
import { recommendedComponentNames } from '../utils/cli.js'
import { installProgressReporter, output } from '../utils/output.js'

export function suggestConfiguration(json: boolean): void {
  const paths = getPaths()
  const suggestedRuntime = defaultSourceForPlatform()
  output(
    {
      platform: process.platform,
      architecture: process.arch,
      stateDirectory: paths.root,
      recommendedRuntime: suggestedRuntime,
      runtimeSources: sourcesForPlatform().map((source) => ({
        source: source.id,
        label: source.label,
        kind: source.kind,
        runnable: canRunRuntimeOnThisSystem(source.id),
        recommended: source.id === suggestedRuntime,
        note:
          source.id === 'game-porting-toolkit' && process.arch !== 'arm64'
            ? 'GPTK requires Apple Silicon and macOS Sonoma or later.'
            : source.kind === 'proton'
              ? 'Proton is supported on Linux.'
              : undefined
      })),
      components: compatibleComponentRecommendations().map((component) => ({
        ...component,
        install: `wur component install ${component.name}`
      })),
      protonNote:
        process.platform === 'darwin'
          ? 'Proton is a Linux runtime. On macOS use the Wine/GPTK runtime recommended above.'
          : undefined,
      installRecommended: 'wur install-recommended'
    },
    json
  )
}

export async function installRecommended(options: RecommendedOptions, json: boolean): Promise<void> {
  const paths = getPaths()
  const defaults = await loadDefaults(paths)
  const plan = {
    platform: process.platform,
    architecture: process.arch,
    runtime: defaults.container.runtime,
    components: recommendedComponentNames(defaults.container)
  }
  if (!canRunRuntimeOnThisSystem(plan.runtime.source)) {
    throw new Error(
      `The default runtime ${plan.runtime.source} cannot run on ${process.platform}/${process.arch}. Update defaults.json or run "wur suggest".`
    )
  }
  if (options.dryRun) {
    output({ ...plan, dryRun: true }, json)
    return
  }
  const runtime = await installRuntime(
    plan.runtime.source,
    plan.runtime.version,
    Boolean(options.force),
    paths,
    json ? { quiet: true, onProgress: installProgressReporter(plan.runtime.source) } : undefined
  )
  const components = []
  for (const component of plan.components) {
    components.push(
      await installComponent(
        component.name,
        component.version,
        Boolean(options.force),
        paths,
        json ? { quiet: true, onProgress: installProgressReporter(component.name) } : undefined
      )
    )
  }
  if (!json) output({ ...plan, runtime, components }, false)
}

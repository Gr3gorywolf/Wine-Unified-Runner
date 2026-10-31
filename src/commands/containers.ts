import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadContainer, parseRuntimeReference, saveContainer } from '../services/config.js'
import {
  buildContainer,
  createContainer,
  defaultContainer,
  listBuildableContainers,
  listContainers,
  prepareContainer,
  removeContainer,
  setDefaultContainer
} from '../services/containers.js'
import { runRuntime, stopWineServer } from '../services/launch.js'
import { getPaths } from '../services/paths.js'
import type {
  BuildOptions,
  ContainerConfigureOptions,
  ContainerCreateOptions,
  ContainerExecOptions,
  ContainerNameOptions
} from '../types/index.js'
import { containerComponentKey, requireContainerName } from '../utils/cli.js'
import { output } from '../utils/output.js'
import { componentRuntimeEnvironment } from '../utils/runtimeEnvironment.js'
import { applySettings } from '../utils/settings.js'

export async function buildContainers(
  nameArgument: string | undefined,
  options: BuildOptions,
  json: boolean
): Promise<void> {
  const paths = getPaths()
  const selectedName = options.name || nameArgument
  const names = selectedName ? [selectedName] : await listBuildableContainers(paths)
  const built = []
  for (const name of names) built.push(await buildContainer(name, {}, paths))
  output(built, json)
}

export async function listContainerConfigurations(json: boolean): Promise<void> {
  const paths = getPaths()
  const currentDefault = await defaultContainer(paths)
  output(
    (await listContainers(paths)).map((container) => ({
      name: container.name,
      default: container.name === currentDefault,
      runtime: `${container.runtime.source}/${container.runtime.version}`,
      initialized: existsSync(container.prefix),
      prefix: container.prefix
    })),
    json
  )
}

export async function createContainerConfiguration(
  nameArgument: string | undefined,
  options: ContainerCreateOptions,
  json: boolean
): Promise<void> {
  const name = requireContainerName(nameArgument, options)
  const container = await createContainer(
    name,
    {
      initialize: options.initialize,
      mutate: (created) => {
        if (options.runtime) Object.assign(created.runtime, parseRuntimeReference(options.runtime))
        for (const component of options.component) {
          const [key, enabledValue] = component.split('=', 2)
          if (!key || !enabledValue || !['true', 'false'].includes(enabledValue)) {
            throw new Error(`Component must use NAME=true or NAME=false, received "${component}".`)
          }
          created.components[containerComponentKey(key)].enabled = enabledValue === 'true'
        }
        applySettings(created, options.set)
      }
    },
    getPaths()
  )
  output(container, json)
}

export async function showContainerConfiguration(
  nameArgument: string | undefined,
  options: ContainerNameOptions,
  json: boolean
): Promise<void> {
  output(await loadContainer(requireContainerName(nameArgument, options), getPaths()), json)
}

export async function configureContainer(
  nameArgument: string | undefined,
  options: ContainerConfigureOptions,
  json: boolean
): Promise<void> {
  const name = requireContainerName(nameArgument, options)
  if (!options.set.length) throw new Error('container configure requires at least one --set PATH=VALUE.')
  const paths = getPaths()
  const container = await loadContainer(name, paths)
  applySettings(container, options.set)
  await saveContainer(container, paths)
  output(container, json)
}

export async function selectDefaultContainer(
  nameArgument: string | undefined,
  options: ContainerNameOptions,
  json: boolean
): Promise<void> {
  const name = options.name || nameArgument
  const paths = getPaths()
  if (!name) output({ defaultContainer: (await defaultContainer(paths)) || null }, json)
  else {
    await setDefaultContainer(name, paths)
    output({ defaultContainer: name }, json)
  }
}

export async function removeContainerConfiguration(
  nameArgument: string | undefined,
  options: ContainerNameOptions,
  json: boolean
): Promise<void> {
  output({ removed: true, ...(await removeContainer(requireContainerName(nameArgument, options), getPaths())) }, json)
}

/** Executes a Windows executable or Wine built-in with the container's complete runtime environment. */
export async function executeInContainer(
  program: string,
  programArguments: string[],
  options: ContainerExecOptions,
  json: boolean
): Promise<void> {
  const paths = getPaths()
  const container = await loadContainer(requireContainerName(undefined, options), paths)
  const prepared = await prepareContainer(container, paths)
  const execution = await (async () => {
    try {
      return await runRuntime(prepared.container, prepared.runtime, [program, ...programArguments], {
        protonVerb: prepared.runtime.kind === 'proton' ? 'waitforexitandrun' : 'run',
        cwd: options.cwd ? resolve(options.cwd) : undefined,
        extraEnv: await componentRuntimeEnvironment(prepared.container, prepared.runtime)
      })
    } finally {
      await stopWineServer(prepared.container, prepared.runtime)
    }
  })()
  if (json) output(execution, true)
  if (execution.code !== 0) process.exitCode = execution.code || 1
}

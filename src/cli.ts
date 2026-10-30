#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Command, CommanderError, Help } from 'commander'
import {
  applyGameOverrides,
  defaultSourceForPlatform,
  hasGameLaunchOverrides,
  isRuntimeSource,
  loadContainer,
  loadDefaults,
  loadGameOverrides,
  parseRuntimeReference,
  saveContainer,
  saveDefaults
} from './config.js'
import {
  findInstalledComponent,
  installComponent,
  listComponentReleases,
  listInstalledComponents,
  removeComponent
} from './components.js'
import {
  buildContainer,
  createContainer,
  defaultContainer,
  ensureDefaultContainer,
  listBuildableContainers,
  listContainers,
  prepareContainer,
  removeContainer,
  setDefaultContainer
} from './containers.js'
import { runRuntime, stopWineServer } from './launch.js'
import { getPaths } from './paths.js'
import { installRuntime, listInstalledRuntimes, listReleases, removeRuntime } from './runtime.js'
import {
  canRunRuntimeOnThisSystem,
  compatibleComponentRecommendations,
  componentNames,
  sourcesForPlatform
} from './sources.js'
import type {
  BuildOptions,
  ComponentListOptions,
  ComponentName,
  ContainerConfig,
  ContainerConfigureOptions,
  ContainerCreateOptions,
  ContainerNameOptions,
  ForceOptions,
  GlobalOptions,
  RecommendedOptions,
  RunOptions,
  RuntimeListOptions,
  RuntimeSource,
  SettingsOptions
} from './types/index.js'
import { collectOption, normalizeExecutableFallback, positiveInteger } from './utils/arguments.js'
import { isExecutableFallback } from './utils/executables.js'
import { colors, formatBytes, installProgressReporter, output } from './utils/output.js'
import { applySettings, parseSetExpression, setAtPath } from './utils/settings.js'

// #region Shared command helpers

let jsonOutput = false

function commandUsesJson(command: Command): boolean {
  return Boolean(command.optsWithGlobals<GlobalOptions>().json)
}

function requireContainerName(argument: string | undefined, options: ContainerNameOptions): string {
  const name = options.name || argument
  if (!name) throw new Error('A container name is required. Use --name NAME.')
  return name
}

function asSource(value: string): RuntimeSource {
  if (!isRuntimeSource(value)) throw new Error(`Unknown runtime source "${value}".`)
  return value
}

function asComponent(value: string): ComponentName {
  if (!componentNames.includes(value as ComponentName)) throw new Error(`Unknown component "${value}".`)
  return value as ComponentName
}

function componentKey(name: string): keyof ContainerConfig['components'] {
  const map: Record<string, keyof ContainerConfig['components']> = {
    dxvk: 'dxvk',
    'dxvk-nvapi': 'dxvkNvapi',
    dxvkNvapi: 'dxvkNvapi',
    vkd3d: 'vkd3d',
    'eac-runtime': 'eacRuntime',
    eacRuntime: 'eacRuntime',
    'battleye-runtime': 'battleyeRuntime',
    battleyeRuntime: 'battleyeRuntime'
  }
  if (!map[name]) throw new Error(`Unknown container component "${name}".`)
  return map[name]
}

function recommendedComponentNames(
  container: Pick<ContainerConfig, 'components'>
): Array<{ name: ComponentName; version: string }> {
  const selected: Array<{ name: ComponentName; version: string }> = []
  if (container.components.dxvk.enabled) {
    selected.push({
      name: process.platform === 'darwin' ? 'dxvk-macos' : 'dxvk',
      version: container.components.dxvk.version
    })
  }
  if (process.platform === 'linux') {
    if (container.components.dxvkNvapi.enabled)
      selected.push({ name: 'dxvk-nvapi', version: container.components.dxvkNvapi.version })
    if (container.components.vkd3d.enabled)
      selected.push({ name: 'vkd3d', version: container.components.vkd3d.version })
    if (container.components.eacRuntime.enabled)
      selected.push({ name: 'eac-runtime', version: container.components.eacRuntime.version })
    if (container.components.battleyeRuntime.enabled)
      selected.push({ name: 'battleye-runtime', version: container.components.battleyeRuntime.version })
  }
  return selected
}

// #endregion Shared command helpers

// #region Runtime command handlers

async function listRuntimes(options: RuntimeListOptions, json: boolean): Promise<void> {
  const paths = getPaths()
  const remote = Boolean(options.remote || options.available)
  const source = options.source ? asSource(options.source) : undefined
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

async function installSelectedRuntime(
  sourceValue: string | undefined,
  version = 'latest',
  options: ForceOptions,
  json: boolean
): Promise<void> {
  const source = asSource(sourceValue || defaultSourceForPlatform())
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

async function removeSelectedRuntime(sourceValue: string, version = 'latest', json: boolean): Promise<void> {
  output({ removed: true, ...(await removeRuntime(asSource(sourceValue), version, getPaths())) }, json)
}

// #endregion Runtime command handlers

// #region Component command handlers

async function listComponents(options: ComponentListOptions, json: boolean): Promise<void> {
  const remote = Boolean(options.remote || options.available)
  const name = options.name ? asComponent(options.name) : undefined
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

async function installSelectedComponent(
  nameValue: string,
  version = 'latest',
  options: ForceOptions,
  json: boolean
): Promise<void> {
  const name = asComponent(nameValue)
  const installed = await installComponent(
    name,
    version,
    Boolean(options.force),
    getPaths(),
    json ? { quiet: true, onProgress: installProgressReporter(name) } : undefined
  )
  if (!json) output(installed, false)
}

async function removeSelectedComponent(nameValue: string, version = 'latest', json: boolean): Promise<void> {
  output({ removed: true, ...(await removeComponent(asComponent(nameValue), version, getPaths())) }, json)
}

// #endregion Component command handlers

// #region Recommendation command handlers

function suggestConfiguration(json: boolean): void {
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

async function installRecommended(options: RecommendedOptions, json: boolean): Promise<void> {
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

// #endregion Recommendation command handlers

// #region Container command handlers

async function buildContainers(nameArgument: string | undefined, options: BuildOptions, json: boolean): Promise<void> {
  const paths = getPaths()
  const selectedName = options.name || nameArgument
  const names = selectedName ? [selectedName] : await listBuildableContainers(paths)
  const built = []
  for (const name of names) built.push(await buildContainer(name, {}, paths))
  output(built, json)
}

async function listContainerConfigurations(json: boolean): Promise<void> {
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

async function createContainerConfiguration(
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
          created.components[componentKey(key)].enabled = enabledValue === 'true'
        }
        applySettings(created, options.set)
      }
    },
    getPaths()
  )
  output(container, json)
}

async function showContainerConfiguration(
  nameArgument: string | undefined,
  options: ContainerNameOptions,
  json: boolean
): Promise<void> {
  output(await loadContainer(requireContainerName(nameArgument, options), getPaths()), json)
}

async function configureContainer(
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

async function selectDefaultContainer(
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

async function removeContainerConfiguration(
  nameArgument: string | undefined,
  options: ContainerNameOptions,
  json: boolean
): Promise<void> {
  output({ removed: true, ...(await removeContainer(requireContainerName(nameArgument, options), getPaths())) }, json)
}

// #endregion Container command handlers

// #region Defaults command handlers

async function showDefaults(json: boolean): Promise<void> {
  output(await loadDefaults(getPaths()), json)
}

async function setDefaults(options: SettingsOptions, json: boolean): Promise<void> {
  if (!options.set.length) throw new Error('defaults set requires at least one --set PATH=VALUE.')
  const paths = getPaths()
  const defaults = await loadDefaults(paths)
  for (const expression of options.set) {
    const { path, value } = parseSetExpression(expression)
    setAtPath(defaults.container as unknown as Record<string, unknown>, path, value)
  }
  await saveDefaults(defaults, paths)
  output(defaults, json)
}

// #endregion Defaults command handlers

// #region Run command handler

async function componentRuntimeEnvironment(container: ContainerConfig): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'linux') return {}
  const paths = getPaths()
  const extra: NodeJS.ProcessEnv = {}
  if (container.components.eacRuntime.enabled) {
    const eac = await findInstalledComponent('eac-runtime', container.components.eacRuntime.version, paths)
    if (eac) extra.PROTON_EAC_RUNTIME = eac.path
  }
  if (container.components.battleyeRuntime.enabled) {
    const battleye = await findInstalledComponent(
      'battleye-runtime',
      container.components.battleyeRuntime.version,
      paths
    )
    if (battleye) extra.PROTON_BATTLEYE_RUNTIME = battleye.path
  }
  return extra
}

async function runExecutable(
  executable: string,
  gameArgs: string[],
  options: RunOptions,
  json: boolean
): Promise<void> {
  const paths = getPaths()
  const executablePath = resolve(executable)
  const gameOverrides = await loadGameOverrides(executablePath, paths)
  const selectedContainer = options.container || gameOverrides.overrides.containerName
  const container = selectedContainer
    ? await loadContainer(selectedContainer, paths)
    : await ensureDefaultContainer(paths)
  const launchContainer = applyGameOverrides(container, gameOverrides.overrides)
  const prepared = await prepareContainer(launchContainer, paths, {
    persist: !hasGameLaunchOverrides(gameOverrides.overrides)
  })
  const execution = await (async () => {
    try {
      return await runRuntime(prepared.container, prepared.runtime, [executablePath, ...gameArgs], {
        protonVerb: prepared.runtime.kind === 'proton' ? 'waitforexitandrun' : 'run',
        cwd: options.cwd ? resolve(options.cwd) : dirname(executablePath),
        installPath: dirname(executablePath),
        extraEnv: await componentRuntimeEnvironment(prepared.container)
      })
    } finally {
      await stopWineServer(prepared.container, prepared.runtime)
    }
  })()
  if (json) output(execution, true)
  if (execution.code !== 0) process.exitCode = execution.code || 1
}

// #endregion Run command handler

function createProgram(): Command {
  const program = new Command()
    .name('wur')
    .description(
      'WUR — Wine Unified Runner. Portable Wine environments and Windows game launching for macOS and Linux.'
    )
    .option('--home <directory>', 'use another self-contained state directory')
    .option('--json', 'emit machine-readable JSON')
    .allowExcessArguments(false)
    .showSuggestionAfterError()
    .exitOverride()
    .addHelpCommand(true)

  program.configureHelp({
    formatHelp: (command, helper) =>
      new Help()
        .formatHelp(command, helper)
        .replace(/^(Usage|Arguments|Options|Global Options|Commands):/gmu, (heading) =>
          colors.yellow(colors.bold(heading))
        )
  })
  program.addHelpText(
    'after',
    colors.dim('\nState stays beside WUR: user/, runtimes/, components/, containers/, downloads/, and config/.')
  )
  program.hook('preAction', (_command, actionCommand) => {
    const options = actionCommand.optsWithGlobals<GlobalOptions>()
    if (options.home) process.env.WUR_HOME = resolve(options.home)
    jsonOutput = Boolean(options.json)
  })

  // #region Runtime commands

  const runtime = program.command('runtime').description('manage Wine and Proton runtimes')
  runtime
    .command('list')
    .description('list installed runtimes, or remote releases with --remote')
    .option('--remote', 'show remote releases instead of installed runtimes')
    .option('--available', 'alias for --remote')
    .option('--all', 'include releases for other platforms')
    .option('--source <source>', 'filter by runtime source')
    .option('--limit <number>', 'maximum releases per source', positiveInteger, 30)
    .action((options: RuntimeListOptions, command: Command) => listRuntimes(options, commandUsesJson(command)))
  runtime
    .command('install')
    .description('install the platform default or a selected runtime')
    .argument('[source]', 'runtime source')
    .argument('[version]', 'runtime version', 'latest')
    .option('--force', 'replace an existing installation')
    .action((source: string | undefined, version: string, options: ForceOptions, command: Command) =>
      installSelectedRuntime(source, version, options, commandUsesJson(command))
    )
  runtime
    .command('remove')
    .alias('delete')
    .description('remove an installed runtime')
    .argument('<source>', 'runtime source')
    .argument('[version]', 'runtime version', 'latest')
    .action((source: string, version: string, _options: object, command: Command) =>
      removeSelectedRuntime(source, version, commandUsesJson(command))
    )
  runtime.command('installed', { hidden: true }).action(() => {
    throw new Error('Use runtime list, runtime install, or runtime remove.')
  })

  // #endregion Runtime commands

  // #region Component commands

  const component = program.command('component').description('manage DXVK, DXMT, VKD3D and supporting runtimes')
  component
    .command('list')
    .description('list installed components, or remote releases with --remote')
    .option('--remote', 'show remote releases instead of installed components')
    .option('--available', 'alias for --remote')
    .option('--all', 'include components for other platforms')
    .option('--name <name>', 'filter by component name')
    .option('--limit <number>', 'maximum releases per component', positiveInteger, 30)
    .action((options: ComponentListOptions, command: Command) => listComponents(options, commandUsesJson(command)))
  component
    .command('install')
    .description('install a component')
    .argument('<name>', 'component name')
    .argument('[version]', 'component version', 'latest')
    .option('--force', 'replace an existing installation')
    .action((name: string, version: string, options: ForceOptions, command: Command) =>
      installSelectedComponent(name, version, options, commandUsesJson(command))
    )
  component
    .command('remove')
    .alias('delete')
    .description('remove an installed component')
    .argument('<name>', 'component name')
    .argument('[version]', 'component version', 'latest')
    .action((name: string, version: string, _options: object, command: Command) =>
      removeSelectedComponent(name, version, commandUsesJson(command))
    )

  // #endregion Component commands

  // #region Setup and recommendation commands

  program
    .command('install-recommended')
    .description('install the runtime and components selected in config/defaults.json')
    .option('--force', 'replace existing installations')
    .option('--dry-run', 'show the installation plan without downloading')
    .action((options: RecommendedOptions, command: Command) => installRecommended(options, commandUsesJson(command)))
  program
    .command('build')
    .description('build container.json and prefixes from containers/*/config.json')
    .argument('[name]', 'container name')
    .option('--name <name>', 'container name')
    .action((name: string | undefined, options: BuildOptions, command: Command) =>
      buildContainers(name, options, commandUsesJson(command))
    )
  program
    .command('suggest')
    .description('show compatible runtime and component recommendations')
    .action((_options: object, command: Command) => suggestConfiguration(commandUsesJson(command)))

  // #endregion Setup and recommendation commands

  // #region Container commands

  const container = program.command('container').description('manage portable Wine prefixes')
  container
    .command('list')
    .description('list containers and the current default')
    .action((_options: object, command: Command) => listContainerConfigurations(commandUsesJson(command)))
  container
    .command('create')
    .description('create a configured Wine prefix')
    .argument('[name]', 'container name')
    .option('--name <name>', 'container name')
    .option('--runtime <source/version>', 'runtime reference')
    .option('--component <name=true|false>', 'enable or disable a component', collectOption, [])
    .option('--set <path=value>', 'override a container setting', collectOption, [])
    .option('--no-initialize', 'write the configuration without creating the prefix')
    .action((name: string | undefined, options: ContainerCreateOptions, command: Command) =>
      createContainerConfiguration(name, options, commandUsesJson(command))
    )
  container
    .command('show')
    .description('show one container configuration')
    .argument('[name]', 'container name')
    .option('--name <name>', 'container name')
    .action((name: string | undefined, options: ContainerNameOptions, command: Command) =>
      showContainerConfiguration(name, options, commandUsesJson(command))
    )
  container
    .command('configure')
    .description('change validated container settings')
    .argument('[name]', 'container name')
    .option('--name <name>', 'container name')
    .option('--set <path=value>', 'override a container setting', collectOption, [])
    .action((name: string | undefined, options: ContainerConfigureOptions, command: Command) =>
      configureContainer(name, options, commandUsesJson(command))
    )
  container
    .command('default')
    .description('show or select the default container')
    .argument('[name]', 'container name')
    .option('--name <name>', 'container name')
    .action((name: string | undefined, options: ContainerNameOptions, command: Command) =>
      selectDefaultContainer(name, options, commandUsesJson(command))
    )
  container
    .command('remove')
    .alias('delete')
    .description('remove a container and its prefix')
    .argument('[name]', 'container name')
    .option('--name <name>', 'container name')
    .action((name: string | undefined, options: ContainerNameOptions, command: Command) =>
      removeContainerConfiguration(name, options, commandUsesJson(command))
    )

  // #endregion Container commands

  // #region Defaults commands

  const defaults = program.command('defaults').description('manage defaults for new containers')
  defaults
    .command('show')
    .description('show the platform-aware default container template')
    .action((_options: object, command: Command) => showDefaults(commandUsesJson(command)))
  defaults
    .command('set')
    .description('change defaults for newly created containers')
    .option('--set <path=value>', 'override a default setting', collectOption, [])
    .action((options: SettingsOptions, command: Command) => setDefaults(options, commandUsesJson(command)))

  // #endregion Defaults commands

  // #region Run command

  program
    .command('run')
    .description('launch a Windows executable with the selected or default container')
    .argument('<executable>', 'Windows executable or script')
    .argument('[arguments...]', 'arguments passed to the Windows program')
    .option('--container <name>', 'container to use')
    .option('--cwd <directory>', 'working directory')
    .action((executable: string, gameArgs: string[], options: RunOptions, command: Command) =>
      runExecutable(executable, gameArgs || [], options, commandUsesJson(command))
    )

  // #endregion Run command

  return program
}

async function main(): Promise<void> {
  const program = createProgram()
  const args = normalizeExecutableFallback(process.argv.slice(2), isExecutableFallback)
  if (!args.length) {
    program.outputHelp()
    return
  }
  try {
    await program.parseAsync(args, { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) process.exitCode = error.exitCode
      return
    }
    throw error
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (jsonOutput) console.log(JSON.stringify({ error: message }))
  else console.error(`Error: ${message}`)
  process.exitCode = 1
})

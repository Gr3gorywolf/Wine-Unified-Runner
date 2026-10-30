#!/usr/bin/env node
import { resolve } from 'node:path'
import { Command, CommanderError, Help } from 'commander'
import {
  buildContainers,
  configureContainer,
  createContainerConfiguration,
  installRecommended,
  installSelectedComponent,
  installSelectedRuntime,
  listComponents,
  listContainerConfigurations,
  listRuntimes,
  removeContainerConfiguration,
  removeSelectedComponent,
  removeSelectedRuntime,
  runExecutable,
  selectDefaultContainer,
  setDefaults,
  showContainerConfiguration,
  showDefaults,
  suggestConfiguration
} from './commands/index.js'
import type {
  BuildOptions,
  ComponentListOptions,
  ContainerConfigureOptions,
  ContainerCreateOptions,
  ContainerNameOptions,
  ForceOptions,
  GlobalOptions,
  RecommendedOptions,
  RunOptions,
  RuntimeListOptions,
  SettingsOptions
} from './types/index.js'
import { collectOption, normalizeExecutableFallback, positiveInteger } from './utils/arguments.js'
import { commandUsesJson } from './utils/cli.js'
import { isExecutableFallback } from './utils/executables.js'
import { colors } from './utils/output.js'

let jsonOutput = false

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

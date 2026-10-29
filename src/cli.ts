#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  defaultSourceForPlatform,
  applyGameOverrides,
  hasGameLaunchOverrides,
  isRuntimeSource,
  loadGameOverrides,
  loadContainer,
  loadDefaults,
  parseRuntimeReference,
  parseSetExpression,
  saveContainer,
  saveDefaults,
  setAtPath
} from './config.js'
import {
  canRunRuntimeOnThisSystem,
  compatibleComponentRecommendations,
  componentNames,
  sourcesForPlatform
} from './sources.js'
import {
  findInstalledComponent,
  installComponent,
  listComponentReleases,
  listInstalledComponents,
  removeComponent
} from './components.js'
import {
  createContainer,
  buildContainer,
  defaultContainer,
  ensureDefaultContainer,
  listContainers,
  listBuildableContainers,
  prepareContainer,
  removeContainer,
  setDefaultContainer
} from './containers.js'
import { runRuntime, stopWineServer } from './launch.js'
import { getPaths } from './paths.js'
import { installRuntime, listInstalledRuntimes, listReleases, removeRuntime } from './runtime.js'
import { isExecutableFallback } from './invocation.js'
import type { ComponentName, ContainerConfig, RuntimeSource } from './types.js'

const colorEnabled = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' && (
  process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0' || Boolean(process.stdout.isTTY)
)
let jsonOutput = false

function color(code: number, text: string): string {
  return colorEnabled ? `\u001B[${code}m${text}\u001B[0m` : text
}

const bold = (text: string): string => color(1, text)
const dim = (text: string): string => color(2, text)
const green = (text: string): string => color(32, text)
const yellow = (text: string): string => color(33, text)
const cyan = (text: string): string => color(36, text)
const magenta = (text: string): string => color(35, text)

function helpSection(title: string, commands: Array<[syntax: string, description: string]>): string {
  return [cyan(bold(title)), ...commands.flatMap(([syntax, description]) => [green(`  ${syntax}`), dim(`      ${description}`)])].join('\n')
}

function usage(): string {
  return [
    `${magenta(bold('WUR'))} ${dim('— Wine Unified Runner')}`,
    dim('Portable Wine environments and Windows game launching for macOS and Linux.'),
    '',
    yellow(bold('USAGE')),
    `  ${green('wur')} ${bold('<command>')} ${dim('[options]')}`,
    '',
    helpSection('LAUNCH A WINDOWS PROGRAM', [
      ['wur run EXECUTABLE [--container NAME] [--cwd DIRECTORY] [-- ARGUMENTS...]', 'Launch an executable with the selected or default container.'],
      ['wur WINDOWS-EXECUTABLE [--container NAME] [--cwd DIRECTORY] [-- ARGUMENTS...]', 'Shortcut for run when the first argument is an existing Windows-launchable file.']
    ]),
    '',
    helpSection('RUNTIMES', [
      ['wur runtime list [--remote] [--all] [--source SOURCE] [--limit N] [--json]', 'List installed runtimes, or remote releases with --remote.'],
      ['wur runtime install [SOURCE] [VERSION] [--force] [--json]', 'Install the platform default, or a specific runtime; VERSION defaults to latest.'],
      ['wur runtime remove SOURCE [VERSION] [--json]', 'Remove a managed runtime.']
    ]),
    '',
    helpSection('COMPONENTS', [
      ['wur component list [--remote] [--all] [--name NAME] [--limit N] [--json]', 'List installed components, or releases with --remote.'],
      ['wur component install NAME [VERSION] [--force] [--json]', 'Download a component such as dxvk, vkd3d, or dxmt.'],
      ['wur component remove NAME [VERSION] [--json]', 'Remove a managed component.'],
      ['wur install-recommended [--force] [--dry-run] [--json]', 'Install the runtime and enabled components from config/defaults.json.']
    ]),
    '',
    helpSection('CONTAINERS', [
      ['wur container create --name NAME [--runtime SOURCE/VERSION] [--component NAME=true] [--set PATH=VALUE] [--no-initialize]', 'Create a Wine prefix and its container.json.'],
      ['wur container list [--json]', 'List containers and show the current default.'],
      ['wur container show --name NAME [--json]', 'Show one container configuration.'],
      ['wur container configure --name NAME --set PATH=VALUE [--set PATH=VALUE]', 'Change validated container settings.'],
      ['wur container default [--name NAME]', 'Show or select the default container.'],
      ['wur container remove --name NAME [--json]', 'Remove a container and its prefix.'],
      ['wur build [--name NAME] [--json]', 'Build container.json and a prefix from containers/<name>/config.json.']
    ]),
    '',
    helpSection('CONFIGURATION AND DISCOVERY', [
      ['wur suggest [--json]', 'Show compatible runtime and component recommendations.'],
      ['wur defaults show [--json]', 'Show the platform-aware default container template.'],
      ['wur defaults set --set PATH=VALUE [--set PATH=VALUE]', 'Change defaults for newly created containers.']
    ]),
    '',
    helpSection('GLOBAL OPTIONS', [
      ['--home DIRECTORY', 'Use another self-contained state directory for this invocation.'],
      ['--json', 'Emit machine-readable JSON for commands that support output.'],
      ['--', 'Pass the remaining arguments to the Windows program.'],
      ['-h, --help', 'Show this help.']
    ]),
    '',
    dim('State stays beside the CLI: user/, runtimes/, components/, containers/, downloads/, and config/.'),
    dim('Use WUR_HOME to make another directory portable. Container files live at containers/<name>/container.json.')
  ].join('\n')
}

function setHomeArgument(args: string[]): string[] {
  const next = [...args]
  const boundary = next.indexOf('--')
  const index = next.findIndex((value, position) => (boundary === -1 || position < boundary) && (value === '--home' || value.startsWith('--home=')))
  if (index < 0) return next
  const token = next[index]
  const value = token.includes('=') ? token.slice('--home='.length) : next[index + 1]
  if (!value) throw new Error('--home requires a directory.')
  process.env.WUR_HOME = resolve(value)
  next.splice(index, token.includes('=') ? 1 : 2)
  return next
}

function hasGlobalJsonFlag(args: string[]): boolean {
  const boundary = args.indexOf('--')
  return args.slice(0, boundary === -1 ? args.length : boundary).includes('--json')
}

function takeFlag(args: string[], name: string): boolean {
  let found = false
  const boundary = args.indexOf('--')
  const lastIndex = boundary === -1 ? args.length - 1 : boundary - 1
  for (let index = lastIndex; index >= 0; index--) {
    if (args[index] === name) {
      args.splice(index, 1)
      found = true
    }
  }
  return found
}

function takeOption(args: string[], name: string): string | undefined {
  let result: string | undefined
  for (let index = args.length - 1; index >= 0; index--) {
    const token = args[index]
    if (token === name) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
      args.splice(index, 2)
      result = value
    } else if (token.startsWith(`${name}=`)) {
      args.splice(index, 1)
      result = token.slice(name.length + 1)
    }
  }
  return result
}

function takeOptions(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length;) {
    const token = args[index]
    if (token === name) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
      values.push(value)
      args.splice(index, 2)
    } else if (token.startsWith(`${name}=`)) {
      values.push(token.slice(name.length + 1))
      args.splice(index, 1)
    } else {
      index++
    }
  }
  return values
}

function requireName(args: string[]): string {
  const name = takeOption(args, '--name') || args.shift()
  if (!name) throw new Error('A container name is required. Use --name NAME.')
  return name
}

function output(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      console.log('No entries found.')
      return
    }
    console.table(value)
    return
  }
  if (typeof value === 'object') console.log(JSON.stringify(value, null, 2))
  else console.log(value)
}

function installProgressReporter(name: string): (progress: number) => void {
  let lastProgress = -1
  return (progress) => {
    const normalized = Math.min(100, Math.max(0, Math.floor(progress)))
    if (normalized === lastProgress) return
    lastProgress = normalized
    console.log(JSON.stringify({ name, progress: normalized }))
  }
}

function bytes(value: number): string {
  if (!value) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let index = 0
  let amount = value
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++ }
  return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`
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

function recommendedComponentNames(container: Pick<ContainerConfig, 'components'>): Array<{ name: ComponentName; version: string }> {
  const selected: Array<{ name: ComponentName; version: string }> = []
  if (container.components.dxvk.enabled) {
    selected.push({
      name: process.platform === 'darwin' ? 'dxvk-macos' : 'dxvk',
      version: container.components.dxvk.version
    })
  }
  if (process.platform === 'linux') {
    if (container.components.dxvkNvapi.enabled) {
      selected.push({ name: 'dxvk-nvapi', version: container.components.dxvkNvapi.version })
    }
    if (container.components.vkd3d.enabled) {
      selected.push({ name: 'vkd3d', version: container.components.vkd3d.version })
    }
    if (container.components.eacRuntime.enabled) {
      selected.push({ name: 'eac-runtime', version: container.components.eacRuntime.version })
    }
    if (container.components.battleyeRuntime.enabled) {
      selected.push({ name: 'battleye-runtime', version: container.components.battleyeRuntime.version })
    }
  }
  return selected
}

function applySettings(container: ContainerConfig, expressions: string[]): void {
  for (const expression of expressions) {
    const { path, value } = parseSetExpression(expression)
    setAtPath(container as unknown as Record<string, unknown>, path, value)
  }
}

async function commandRuntime(args: string[], json: boolean): Promise<void> {
  const verb = args.shift()
  const paths = getPaths()
  if (verb === 'list') {
    const remote = takeFlag(args, '--remote') || takeFlag(args, '--available')
    const sourceValue = takeOption(args, '--source')
    const source = sourceValue ? asSource(sourceValue) : undefined
    const limit = Number(takeOption(args, '--limit') || '30')
    const all = takeFlag(args, '--all')
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    if (!remote) {
      const installed = await listInstalledRuntimes(paths)
      output(source ? installed.filter((runtime) => runtime.source === source) : installed, json)
      return
    }
    if (source && !all && !canRunRuntimeOnThisSystem(source)) {
      throw new Error(`Runtime source "${source}" is not compatible with ${process.platform}/${process.arch}. Use --all only to inspect cross-platform releases.`)
    }
    const releases = await listReleases(source, limit, all)
    output(releases.map((release) => ({
      source: release.source,
      version: release.version,
      date: release.date,
      size: bytes(release.size),
      latest: Boolean(release.latest),
      recommended: release.source === defaultSourceForPlatform()
    })), json)
    return
  }
  if (verb === 'install') {
    const force = takeFlag(args, '--force')
    const source = asSource(args.shift() || defaultSourceForPlatform())
    const version = args.shift() || 'latest'
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    if (!canRunRuntimeOnThisSystem(source)) {
      const alternatives = sourcesForPlatform().map((candidate) => candidate.id).join(', ')
      throw new Error(`Runtime source "${source}" cannot run on ${process.platform}/${process.arch}. Use one of: ${alternatives || 'no supported runtime detected'}.`)
    }
    const installed = await installRuntime(source, version, force, paths, json
      ? { quiet: true, onProgress: installProgressReporter(source) }
      : undefined)
    if (!json) output(installed, false)
    return
  }
  if (verb === 'remove' || verb === 'delete') {
    const source = asSource(args.shift() || '')
    const version = args.shift() || 'latest'
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    output({ removed: true, ...(await removeRuntime(source, version, paths)) }, json)
    return
  }
  throw new Error('Use runtime list, runtime install, or runtime remove.')
}

async function commandComponent(args: string[], json: boolean): Promise<void> {
  const verb = args.shift()
  const paths = getPaths()
  if (verb === 'list') {
    const remote = takeFlag(args, '--remote') || takeFlag(args, '--available')
    const all = takeFlag(args, '--all')
    const nameOption = takeOption(args, '--name')
    const name = nameOption ? asComponent(nameOption) : undefined
    const limit = Number(takeOption(args, '--limit') || '30')
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    if (remote) {
      const recommendations = compatibleComponentRecommendations(all)
      const releases = await listComponentReleases(name, limit, all)
      output(releases.map((release) => ({
        name: release.name,
        version: release.version,
        date: release.date,
        size: bytes(release.size),
        recommended: recommendations.find((component) => component.name === release.name)?.recommended ?? false
      })), json)
    } else {
      output(await listInstalledComponents(paths), json)
    }
    return
  }
  if (verb === 'install') {
    const force = takeFlag(args, '--force')
    const name = asComponent(args.shift() || '')
    const version = args.shift() || 'latest'
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    const installed = await installComponent(name, version, force, paths, json
      ? { quiet: true, onProgress: installProgressReporter(name) }
      : undefined)
    if (!json) output(installed, false)
    return
  }
  if (verb === 'remove' || verb === 'delete') {
    const name = asComponent(args.shift() || '')
    const version = args.shift() || 'latest'
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    output({ removed: true, ...(await removeComponent(name, version, paths)) }, json)
    return
  }
  throw new Error('Use component list, component install, or component remove.')
}

function commandSuggest(json: boolean): void {
  const paths = getPaths()
  const suggestedRuntime = defaultSourceForPlatform()
  output({
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
      note: source.id === 'game-porting-toolkit' && process.arch !== 'arm64'
        ? 'GPTK requires Apple Silicon and macOS Sonoma or later.'
        : source.kind === 'proton' ? 'Proton is supported on Linux.' : undefined
    })),
    components: compatibleComponentRecommendations().map((component) => ({
      ...component,
      install: `wur component install ${component.name}`
    })),
    protonNote: process.platform === 'darwin'
      ? 'Proton is a Linux runtime. On macOS use the Wine/GPTK runtime recommended above.'
      : undefined,
    installRecommended: 'wur install-recommended'
  }, json)
}

async function commandInstallRecommended(args: string[], json: boolean): Promise<void> {
  const force = takeFlag(args, '--force')
  const dryRun = takeFlag(args, '--dry-run')
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
  const paths = getPaths()
  const defaults = await loadDefaults(paths)
  const plan = {
    platform: process.platform,
    architecture: process.arch,
    runtime: defaults.container.runtime,
    components: recommendedComponentNames(defaults.container)
  }
  if (!canRunRuntimeOnThisSystem(plan.runtime.source)) {
    throw new Error(`The default runtime ${plan.runtime.source} cannot run on ${process.platform}/${process.arch}. Update defaults.json or run "wur suggest".`)
  }
  if (dryRun) {
    output({ ...plan, dryRun: true }, json)
    return
  }

  const runtime = await installRuntime(plan.runtime.source, plan.runtime.version, force, paths, json
    ? { quiet: true, onProgress: installProgressReporter(plan.runtime.source) }
    : undefined)
  const components = []
  for (const component of plan.components) {
    components.push(await installComponent(component.name, component.version, force, paths, json
      ? { quiet: true, onProgress: installProgressReporter(component.name) }
      : undefined))
  }
  if (!json) output({ ...plan, runtime, components }, false)
}

async function commandBuild(args: string[], json: boolean): Promise<void> {
  const name = takeOption(args, '--name') || args.shift()
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
  const paths = getPaths()
  const names = name ? [name] : await listBuildableContainers(paths)
  const built = []
  for (const containerName of names) built.push(await buildContainer(containerName, {}, paths))
  output(built, json)
}

async function commandContainer(args: string[], json: boolean): Promise<void> {
  const verb = args.shift()
  const paths = getPaths()
  if (verb === 'list') {
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    const currentDefault = await defaultContainer(paths)
    const rows = (await listContainers(paths)).map((container) => ({
      name: container.name,
      default: container.name === currentDefault,
      runtime: `${container.runtime.source}/${container.runtime.version}`,
      initialized: existsSync(container.prefix),
      prefix: container.prefix
    }))
    output(rows, json)
    return
  }
  if (verb === 'create') {
    const noInitialize = takeFlag(args, '--no-initialize')
    const name = requireName(args)
    const runtimeOption = takeOption(args, '--runtime')
    const componentOptions = takeOptions(args, '--component')
    const settings = takeOptions(args, '--set')
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    const container = await createContainer(name, {
      initialize: !noInitialize,
      mutate: (created) => {
        if (runtimeOption) Object.assign(created.runtime, parseRuntimeReference(runtimeOption))
        for (const option of componentOptions) {
          const [key, enabledValue] = option.split('=', 2)
          if (!key || !enabledValue || !['true', 'false'].includes(enabledValue)) throw new Error(`Component must use NAME=true or NAME=false, received "${option}".`)
          created.components[componentKey(key)].enabled = enabledValue === 'true'
        }
        applySettings(created, settings)
      }
    }, paths)
    output(container, json)
    return
  }
  if (verb === 'show') {
    const name = requireName(args)
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    output(await loadContainer(name, paths), json)
    return
  }
  if (verb === 'configure') {
    const name = requireName(args)
    const settings = takeOptions(args, '--set')
    if (!settings.length) throw new Error('container configure requires at least one --set PATH=VALUE.')
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    const container = await loadContainer(name, paths)
    applySettings(container, settings)
    await saveContainer(container, paths)
    output(container, json)
    return
  }
  if (verb === 'default') {
    const name = takeOption(args, '--name') || args.shift()
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    if (!name) {
      output({ defaultContainer: await defaultContainer(paths) || null }, json)
    } else {
      await setDefaultContainer(name, paths)
      output({ defaultContainer: name }, json)
    }
    return
  }
  if (verb === 'remove' || verb === 'delete') {
    const name = requireName(args)
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    output({ removed: true, ...(await removeContainer(name, paths)) }, json)
    return
  }
  throw new Error('Use container create, list, show, configure, default, or remove.')
}

async function commandDefaults(args: string[], json: boolean): Promise<void> {
  const verb = args.shift()
  const paths = getPaths()
  if (verb === 'show') {
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    output(await loadDefaults(paths), json)
    return
  }
  if (verb === 'set') {
    const settings = takeOptions(args, '--set')
    if (!settings.length) throw new Error('defaults set requires at least one --set PATH=VALUE.')
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
    const defaults = await loadDefaults(paths)
    for (const expression of settings) {
      const { path, value } = parseSetExpression(expression)
      setAtPath(defaults.container as unknown as Record<string, unknown>, path, value)
    }
    await saveDefaults(defaults, paths)
    output(defaults, json)
    return
  }
  throw new Error('Use defaults show or defaults set.')
}

async function componentRuntimeEnvironment(container: ContainerConfig): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'linux') return {}
  const paths = getPaths()
  const extra: NodeJS.ProcessEnv = {}
  if (container.components.eacRuntime.enabled) {
    const eac = await findInstalledComponent('eac-runtime', container.components.eacRuntime.version, paths)
    if (eac) extra.PROTON_EAC_RUNTIME = eac.path
  }
  if (container.components.battleyeRuntime.enabled) {
    const battleye = await findInstalledComponent('battleye-runtime', container.components.battleyeRuntime.version, paths)
    if (battleye) extra.PROTON_BATTLEYE_RUNTIME = battleye.path
  }
  return extra
}

async function commandRun(args: string[], json: boolean): Promise<void> {
  const split = args.indexOf('--')
  const gameArgs = split >= 0 ? args.splice(split + 1) : []
  if (split >= 0) args.splice(split)
  const name = takeOption(args, '--container')
  const cwd = takeOption(args, '--cwd')
  const executable = args.shift()
  if (!executable) throw new Error('run requires an executable path.')
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}. Put program arguments after --.`)
  const paths = getPaths()
  const executablePath = resolve(executable)
  const gameOverrides = await loadGameOverrides(executablePath, paths)
  // An explicit CLI flag always controls selection; the sidecar still applies
  // its runtime, component, launch, and environment settings for this run.
  const selectedContainer = name || gameOverrides.overrides.containerName
  const container = selectedContainer ? await loadContainer(selectedContainer, paths) : await ensureDefaultContainer(paths)
  const launchContainer = applyGameOverrides(container, gameOverrides.overrides)
  const prepared = await prepareContainer(launchContainer, paths, { persist: !hasGameLaunchOverrides(gameOverrides.overrides) })
  const execution = await (async () => {
    try {
      return await runRuntime(prepared.container, prepared.runtime, [executablePath, ...gameArgs], {
        protonVerb: prepared.runtime.kind === 'proton' ? 'waitforexitandrun' : 'run',
        cwd: cwd ? resolve(cwd) : dirname(executablePath),
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

async function main(): Promise<void> {
  let args = process.argv.slice(2)
  jsonOutput = hasGlobalJsonFlag(args)
  args = setHomeArgument(args)
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  const json = takeFlag(args, '--json')
  jsonOutput = json
  const command = args.shift()
  // An existing Windows executable in command position is shorthand for `run`.
  // Requiring a regular file prevents an accidental typo from changing the
  // command parser's usual "unknown command" error into a game launch.
  if (command && isExecutableFallback(command)) return await commandRun([command, ...args], json)
  switch (command) {
    case 'runtime': return await commandRuntime(args, json)
    case 'component': return await commandComponent(args, json)
    case 'install-recommended': return await commandInstallRecommended(args, json)
    case 'build': return await commandBuild(args, json)
    case 'suggest':
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`)
      commandSuggest(json)
      return
    case 'container': return await commandContainer(args, json)
    case 'defaults': return await commandDefaults(args, json)
    case 'run': return await commandRun(args, json)
    case 'help': console.log(usage()); return
    default: throw new Error(`Unknown command "${command}".\n\n${usage()}`)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (jsonOutput) console.log(JSON.stringify({ error: message }))
  else console.error(`Error: ${message}`)
  process.exitCode = 1
})

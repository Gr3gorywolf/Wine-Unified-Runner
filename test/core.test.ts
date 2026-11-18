import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  applyGameOverrideExpressions,
  applyGameOverrides,
  loadAppConfig,
  loadContainer,
  loadDefaults,
  loadGameOverrides,
  newContainer,
  parseRuntimeReference,
  parseSetExpression,
  setGameOverrides,
  saveContainer,
  showGameOverrides,
  setAtPath
} from '../src/services/config.js'
import { applyDllComponent, removeComponent } from '../src/services/components.js'
import { buildContainer, createContainer, prepareContainer, removeContainer } from '../src/services/containers.js'
import { buildLaunchEnvironment, runRuntime } from '../src/services/launch.js'
import { isExecutableFallback } from '../src/services/invocation.js'
import { getPaths } from '../src/services/paths.js'
import { ignoresComponent, runtimeSources } from '../src/services/sources.js'
import { readJson, writeJson } from '../src/utils/json.js'
import { containerManifestFile } from '../src/utils/filesystem.js'
import { ensureSharedUserProfile } from '../src/services/profile.js'
import { findRuntimeBinary, removeRuntime, runtimeId } from '../src/services/runtime.js'
import type { ContainerConfig, DefaultsFile, InstalledComponent, InstalledRuntime, Paths } from '../src/types/index.js'

const execFileAsync = promisify(execFile)

function portablePaths(root: string): Paths {
  return {
    root,
    user: join(root, 'user'),
    containers: join(root, 'containers'),
    runtimes: join(root, 'runtimes'),
    components: join(root, 'components'),
    redist: join(root, 'redist'),
    downloads: join(root, 'downloads'),
    appConfig: join(root, 'config', 'config.json'),
    defaults: join(root, 'config', 'defaults.json'),
    bundledDefaults: join(root, 'defaults.json'),
    overrideTemplate: join(root, 'wur-overrides.template.jsonc')
  }
}

const testDefaults: DefaultsFile = {
  schemaVersion: 1,
  container: {
    runtime: { source: 'ge-proton', version: 'latest' },
    architecture: 'win64',
    components: {
      dxvk: { enabled: true, version: 'latest' },
      dxvkNvapi: { enabled: false, version: 'latest' },
      vkd3d: { enabled: true, version: 'latest' },
      eacRuntime: { enabled: false, version: 'latest' },
      battleyeRuntime: { enabled: false, version: 'latest' }
    },
    launch: {
      enableEsync: true,
      enableFsync: true,
      enableMsync: false,
      enableWayland: false,
      enableHdr: false,
      enableWow64: false,
      showFps: false,
      dxvkFrameRate: null,
      fsr: false,
      fsrSharpness: 2,
      verboseLogs: false,
      environment: {}
    }
  }
}

test('defaults create a portable container.json base', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wur-test-'))
  try {
    const paths = portablePaths(home)
    const defaults = await loadDefaults(paths)
    const container = newContainer('my-game', defaults, paths)
    assert.equal(container.name, 'my-game')
    assert.equal(container.prefix, join(home, 'containers', 'my-game', 'prefix'))
    assert.equal(container.components.dxvk.enabled, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

const cliPath = resolve(process.cwd(), 'dist', 'src', 'cli.js')
const defaultCliHome = resolve(process.cwd(), 'dist')

async function setCliHome(home: string): Promise<void> {
  await execFileAsync(process.execPath, [cliPath, 'home', 'set', home])
}

test('the compiled CLI keeps its default state beside the executable', async () => {
  await setCliHome(defaultCliHome)
  try {
    assert.equal(getPaths().root, resolve(process.cwd(), 'dist'))
  } finally {
    await setCliHome(defaultCliHome)
  }
})

test('home set persists a writable state directory and home show returns it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wur-home-'))
  try {
    const set = await execFileAsync(process.execPath, [cliPath, 'home', 'set', home])
    assert.deepEqual(JSON.parse(set.stdout), { home })

    const show = await execFileAsync(process.execPath, [cliPath, 'home', 'show'])
    assert.deepEqual(JSON.parse(show.stdout), { home })

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'home', 'set', join(home, 'missing')]),
      /Home directory does not exist/
    )
  } finally {
    await setCliHome(defaultCliHome)
    await rm(home, { recursive: true, force: true })
  }
})

test('container exec documents built-in tools and graphics diagnostics', async () => {
  const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js')
  const result = await execFileAsync(process.execPath, [cli, 'container', 'exec', '--help'])
  assert.match(result.stdout, /explorer\.exe/)
  assert.match(result.stdout, /dxdiag\.exe/)
  assert.match(result.stdout, /OpenGL or Vulkan diagnostic/)
})

test('container install-redist documents its interactive upstream installer', async () => {
  const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js')
  const result = await execFileAsync(process.execPath, [cli, 'container', 'install-redist', '--help'])
  assert.match(result.stdout, /cached Windows redistributables/)
  assert.match(result.stdout, /reboot prompt/)
})

test('container prepare requires a positional container name and documents dependency installation', async () => {
  const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js')
  const result = await execFileAsync(process.execPath, [cli, 'container', 'prepare', '--help'])
  assert.match(result.stdout, /prepare \[options\] <name>/)
  assert.match(result.stdout, /install dependencies from container\.json/)
})

test('runtime component exclusions are declared by runtime metadata', () => {
  assert.equal(ignoresComponent('wine-crossover', 'dxvk-macos'), false)
  assert.equal(ignoresComponent('wine-staging-macos', 'dxvk-macos'), false)
  assert.deepEqual(runtimeSources['wine-crossover'].ignoredComponents, ['dxvk', 'dxvk-nvapi', 'vkd3d', 'dxmt'])
  assert.equal(runtimeSources['proton-archive'].kind, 'proton')
  assert.equal(ignoresComponent('proton-archive', 'dxvk'), true)
})

test('runtime-owned components are ignored in memory and omitted from container.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-runtime-owned-components-'))
  const paths = portablePaths(root)
  try {
    const container = newContainer('gptk', testDefaults, paths)
    container.runtime = { source: 'game-porting-toolkit', version: 'latest' }
    // Simulate both --component dxvk=true and --set components.dxvk.enabled=true.
    container.components.dxvk.enabled = true
    container.components.dxvkNvapi.enabled = true
    container.components.vkd3d.enabled = true
    await saveContainer(container, paths)

    assert.equal(container.components.dxvk.enabled, false)
    assert.equal(container.components.dxvkNvapi.enabled, false)
    assert.equal(container.components.vkd3d.enabled, false)

    const persisted = await readJson<{ components: Record<string, unknown> }>(
      join(paths.containers, 'gptk', 'container.json')
    )
    assert.equal('dxvk' in persisted.components, false)
    assert.equal('dxvkNvapi' in persisted.components, false)
    assert.equal('vkd3d' in persisted.components, false)
    assert.equal('eacRuntime' in persisted.components, true)
    assert.equal('battleyeRuntime' in persisted.components, true)

    await writeJson(join(paths.containers, 'gptk', 'container.json'), {
      ...persisted,
      components: {
        ...persisted.components,
        dxvk: { enabled: true, version: 'latest' }
      }
    })
    const loaded = await loadContainer('gptk', paths)
    assert.equal(loaded.components.dxvk.enabled, false)
    await saveContainer(loaded, paths)
    const rewritten = await readJson<{ components: Record<string, unknown> }>(
      join(paths.containers, 'gptk', 'container.json')
    )
    assert.equal('dxvk' in rewritten.components, false)

    const overridden = applyGameOverrides(loaded, { components: { dxvk: { enabled: true } } })
    assert.equal(overridden.components.dxvk.enabled, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('container prepare disables a DLL component through registry overrides without deleting its files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-prepare-component-removal-'))
  const paths = portablePaths(root)
  const source = process.platform === 'darwin' ? 'wine-staging-macos' : 'wine-lutris'
  const componentName = process.platform === 'darwin' ? 'dxvk-macos' : 'dxvk'
  const runtimePath = join(paths.runtimes, `${source}--test`)
  const runtimeBin =
    process.platform === 'darwin'
      ? join(runtimePath, 'Contents', 'Resources', 'wine', 'bin', 'wine')
      : join(runtimePath, 'bin', 'wine')
  const commandLog = join(root, 'runtime-commands.log')
  const componentPath = join(paths.components, componentName, 'test')
  try {
    await mkdir(dirname(runtimeBin), { recursive: true })
    await writeFile(runtimeBin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexit 0\n`)
    await chmod(runtimeBin, 0o755)
    await writeJson(join(runtimePath, 'runtime.json'), {
      id: `${source}--test`,
      source,
      version: 'test',
      kind: 'wine',
      path: runtimePath,
      bin: runtimeBin,
      installedAt: '2026-01-01T00:00:00.000Z',
      release: { date: '2026-01-01', download: 'https://example.invalid/wine', notesUrl: 'https://example.invalid' }
    } satisfies InstalledRuntime)

    await mkdir(join(componentPath, 'x64'), { recursive: true })
    await writeFile(join(componentPath, 'x64', 'd3d11.dll'), 'component-dll')
    const component = {
      name: componentName,
      version: 'test',
      path: componentPath,
      installedAt: '2026-01-01T00:00:00.000Z',
      release: {
        date: '2026-01-01',
        download: 'https://example.invalid/component',
        notesUrl: 'https://example.invalid'
      }
    } satisfies InstalledComponent
    await writeJson(join(componentPath, 'component.json'), component)

    const container = newContainer('removal', testDefaults, paths)
    container.runtime = { source, version: 'test' }
    container.components.dxvk = { enabled: false, version: 'test' }
    await mkdir(join(container.prefix, 'drive_c', 'windows', 'system32'), { recursive: true })
    await writeFile(join(container.prefix, 'system.reg'), 'WINE REGISTRY Version 2\n')
    await writeFile(join(container.prefix, 'drive_c', 'windows', 'system32', 'd3d11.dll'), 'builtin-dll')
    await applyDllComponent(component, container.prefix)
    const marker = join(container.prefix, `current_${componentName}`)
    await writeFile(marker, 'test\n')
    await mkdir(dirname(join(paths.containers, container.name, 'container.json')), { recursive: true })
    await saveContainer(container, paths)

    await prepareContainer(container, paths)

    assert.equal(existsSync(marker), true)
    assert.equal(
      await readFile(join(container.prefix, 'drive_c', 'windows', 'system32', 'd3d11.dll'), 'utf8'),
      'component-dll'
    )
    assert.match(await readFile(commandLog, 'utf8'), /reg delete .*DllOverrides \/v d3d11 \/f/u)

    await writeFile(commandLog, '')
    container.components.dxvk.enabled = true
    await prepareContainer(container, paths)
    assert.match(await readFile(commandLog, 'utf8'), /reg add .*DllOverrides \/v d3d11 \/d native,builtin \/f/u)
    assert.equal(await readFile(marker, 'utf8'), 'test\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings path parsing preserves JSON values', () => {
  const target: Record<string, unknown> = { launch: {} }
  const setting = parseSetExpression('launch.enableWayland=true')
  setAtPath(target, setting.path, setting.value)
  assert.deepEqual(target, { launch: { enableWayland: true } })
  assert.deepEqual(parseRuntimeReference('ge-proton/latest'), { source: 'ge-proton', version: 'latest' })
  assert.equal(runtimeId('ge-proton', 'GE-Proton10-1'), 'ge-proton--GE-Proton10-1')
})

test('per-game JSONC overrides are created from the template and apply without changing the container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-overrides-'))
  const paths = portablePaths(root)
  const executable = join(root, 'games', 'Example.exe')
  const sidecar = join(root, 'games', 'wur-overrides.jsonc')
  try {
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, '')
    await writeFile(
      paths.overrideTemplate,
      `{
  // template comments are ignored by the JSONC parser
  "containerName": "sidecar-container",
  "components": {
    "dxvk": { "version": "2.4" },
    "dxvkNvapi": { "enabled": true }
  },
  "launch": {
    "enableHdr": true,
    "dxvkFrameRate": 60,
    "environment": { "DXVK_ASYNC": "1" }
  }
}
`
    )

    const loaded = await loadGameOverrides(executable, paths)
    assert.equal(loaded.file, sidecar)
    assert.equal(loaded.overrides.containerName, 'sidecar-container')
    assert.equal(loaded.overrides.components?.dxvk?.version, '2.4')
    assert.equal(loaded.overrides.components?.dxvkNvapi?.enabled, true)
    assert.equal(loaded.overrides.launch?.enableHdr, true)
    assert.equal(loaded.overrides.launch?.dxvkFrameRate, 60)
    assert.equal(loaded.overrides.launch?.environment?.DXVK_ASYNC, '1')

    const original = newContainer('base', testDefaults, paths)
    original.runtime.source = process.platform === 'darwin' ? 'wine-staging-macos' : 'wine-lutris'
    const effective = applyGameOverrides(original, loaded.overrides)
    assert.equal(effective.components.dxvk.version, '2.4')
    assert.equal(effective.components.dxvkNvapi.enabled, process.platform !== 'darwin')
    assert.equal(effective.launch.enableHdr, true)
    assert.equal(effective.launch.dxvkFrameRate, 60)
    assert.equal(effective.launch.environment.DXVK_ASYNC, '1')
    assert.equal(original.launch.enableHdr, false)

    await rm(sidecar)
    await loadGameOverrides(executable, paths)
    assert.equal(await readFile(sidecar, 'utf8'), await readFile(paths.overrideTemplate, 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('override CLI shows no sidecar as an empty object and set creates and updates its template', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-override-cli-'))
  const executable = join(root, 'games', 'Example.exe')
  const sidecar = join(root, 'games', 'wur-overrides.jsonc')
  const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js')
  try {
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, '')
    await mkdir(join(root, 'home'), { recursive: true })
    await setCliHome(join(root, 'home'))

    const absent = await execFileAsync(process.execPath, [cli, 'override', executable])
    assert.deepEqual(JSON.parse(absent.stdout), {})
    assert.equal(existsSync(sidecar), false)

    const created = await execFileAsync(process.execPath, [cli, 'override', 'set', executable])
    assert.deepEqual(JSON.parse(created.stdout), {})
    assert.equal(existsSync(sidecar), true)

    const updated = await execFileAsync(process.execPath, [
      cli,
      'override',
      'set',
      executable,
      '--val',
      'containerName=example-container',
      '--val',
      'components.dxvk.enabled=true',
      '--val',
      'launch.enableHdr=true',
      '--val',
      'launch.environment.DXVK_ASYNC=1'
    ])
    assert.deepEqual(JSON.parse(updated.stdout), {
      containerName: 'example-container',
      components: { dxvk: { enabled: true } },
      launch: { enableHdr: true, environment: { DXVK_ASYNC: '1' } }
    })
    assert.match(await readFile(sidecar, 'utf8'), /\/\/ WUR per-game launch overrides/u)
    assert.match(await readFile(sidecar, 'utf8'), /"containerName": "example-container"/u)
    assert.match(await readFile(sidecar, 'utf8'), /"enabled": true/u)

    const removed = await execFileAsync(process.execPath, [
      cli,
      'override',
      'set',
      executable,
      '--val',
      'launch.enableHdr=',
      '--val',
      'launch.environment.DXVK_ASYNC='
    ])
    assert.deepEqual(JSON.parse(removed.stdout), {
      containerName: 'example-container',
      components: { dxvk: { enabled: true } }
    })

    const shown = await execFileAsync(process.execPath, [cli, 'override', 'show', executable])
    assert.deepEqual(JSON.parse(shown.stdout), JSON.parse(removed.stdout))

    const deleted = await execFileAsync(process.execPath, [cli, 'override', 'delete', executable])
    assert.deepEqual(JSON.parse(deleted.stdout), { removed: true })
    assert.equal(existsSync(sidecar), false)

    const afterDelete = await execFileAsync(process.execPath, [cli, 'override', executable])
    assert.deepEqual(JSON.parse(afterDelete.stdout), {})
  } finally {
    await setCliHome(defaultCliHome)
    await rm(root, { recursive: true, force: true })
  }
})

test('setGameOverrides validates values before creating a sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-override-values-'))
  const paths = portablePaths(root)
  const executable = join(root, 'games', 'Example.exe')
  const sidecar = join(root, 'games', 'wur-overrides.jsonc')
  try {
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, '')
    await writeFile(paths.overrideTemplate, '{\n  // template\n}\n')

    assert.deepEqual(await showGameOverrides(executable), {})
    await assert.rejects(setGameOverrides(executable, ['launch.enableHdr=invalid'], paths), /Invalid override/)
    await assert.rejects(setGameOverrides(executable, ['enableHdr=true'], paths), /Unknown override key/)
    await assert.rejects(setGameOverrides(executable, ['runtime.version=latest'], paths), /Unknown override key/)
    assert.equal(existsSync(sidecar), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('run override expressions take precedence in memory without mutating JSONC values', () => {
  const sidecarOverrides = {
    containerName: 'sidecar-container',
    components: { dxvk: { enabled: false, version: '2.4' } },
    launch: { enableHdr: false, showFps: true, environment: { DXVK_ASYNC: '0', KEEP: 'yes' } }
  }

  const effective = applyGameOverrideExpressions(sidecarOverrides, [
    'containerName=cli-container',
    'components.dxvk.enabled=true',
    'launch.enableHdr=true',
    'launch.showFps=',
    'launch.environment.DXVK_ASYNC=1',
    'launch.enableHdr=false',
    'launch.enableHdr=true'
  ])

  assert.deepEqual(effective, {
    containerName: 'cli-container',
    components: { dxvk: { enabled: true, version: '2.4' } },
    launch: { enableHdr: true, environment: { DXVK_ASYNC: '1', KEEP: 'yes' } }
  })
  assert.equal(sidecarOverrides.containerName, 'sidecar-container')
  assert.equal(sidecarOverrides.launch.enableHdr, false)
  assert.equal(sidecarOverrides.launch.showFps, true)
})

test('run documents repeatable in-memory game overrides', async () => {
  const result = await execFileAsync(process.execPath, [cliPath, 'run', '--help'])
  assert.match(result.stdout, /--set <path=value>/)
  assert.match(result.stdout, /same syntax as wur override set/)
})

test('an existing Windows-launchable file is eligible for the implicit run command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-invocation-'))
  const extensions = ['com', 'exe', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msc', 'pif', 'scf', 'scr']
  const directoryNamedExe = join(root, 'not-a-game.exe')
  const uppercaseExecutable = join(root, 'Game.EXE')
  try {
    await Promise.all(extensions.map((extension) => writeFile(join(root, `Game.${extension}`), '')))
    await writeFile(uppercaseExecutable, '')
    await mkdir(directoryNamedExe)
    for (const extension of extensions) assert.equal(isExecutableFallback(join(root, `Game.${extension}`)), true)
    assert.equal(isExecutableFallback(uppercaseExecutable), true)
    assert.equal(isExecutableFallback(join(root, 'missing.exe')), false)
    assert.equal(isExecutableFallback(join(root, 'Game.msi')), false)
    assert.equal(isExecutableFallback(directoryNamedExe), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('macOS Wine bundles use the command-line loader instead of the Finder launcher', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'wur-runtime-'))
  const cliWine = join(runtime, 'Contents', 'Resources', 'wine', 'bin', 'wine64')
  const finderLauncher = join(runtime, 'Contents', 'MacOS', 'wine')
  try {
    await mkdir(join(runtime, 'Contents', 'Resources', 'wine', 'bin'), { recursive: true })
    await mkdir(join(runtime, 'Contents', 'MacOS'), { recursive: true })
    await Promise.all([writeFile(cliWine, ''), writeFile(finderLauncher, '')])
    assert.equal(await findRuntimeBinary(runtime, 'toolkit'), cliWine)
  } finally {
    await rm(runtime, { recursive: true, force: true })
  }
})

test('container runtime references remain declarative when legacy metadata is loaded and saved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-runtime-ref-'))
  const paths = portablePaths(root)
  try {
    await mkdir(join(paths.containers, 'portable'), { recursive: true })
    await writeJson(paths.defaults, testDefaults)
    const container = newContainer('portable', testDefaults, paths)
    await writeJson(join(paths.containers, 'portable', 'container.json'), {
      ...container,
      runtime: {
        source: 'ge-proton',
        version: 'latest',
        id: 'ge-proton--latest',
        path: '/old-machine/runtimes/ge-proton--latest',
        kind: 'proton'
      }
    })

    const loaded = await loadContainer('portable', paths)
    assert.deepEqual(loaded.runtime, { source: 'ge-proton', version: 'latest' })
    await saveContainer(loaded, paths)

    const persisted = await readJson<Record<string, unknown>>(join(paths.containers, 'portable', 'container.json'))
    assert.deepEqual(persisted.runtime, { source: 'ge-proton', version: 'latest' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runRuntime returns after its primary process exits and prunes remaining descendants', async () => {
  const started = performance.now()
  const root = await mkdtemp(join(tmpdir(), 'wur-launch-tree-'))
  const childPidFile = join(root, 'child.pid')
  const container = {
    schemaVersion: 1,
    name: 'exit-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    prefix: '/tmp/wur-exit-test',
    architecture: 'win64',
    runtime: { source: 'wine-staging-macos', version: 'test' },
    components: {
      dxvk: { enabled: false, version: 'latest' },
      dxvkNvapi: { enabled: false, version: 'latest' },
      vkd3d: { enabled: false, version: 'latest' },
      eacRuntime: { enabled: false, version: 'latest' },
      battleyeRuntime: { enabled: false, version: 'latest' }
    },
    launch: {
      enableEsync: false,
      enableFsync: false,
      enableMsync: false,
      enableWayland: false,
      enableHdr: false,
      enableWow64: false,
      showFps: false,
      dxvkFrameRate: null,
      fsr: false,
      fsrSharpness: 2,
      verboseLogs: false,
      environment: {}
    }
  } satisfies ContainerConfig
  try {
    const result = await runRuntime(
      container,
      {
        id: 'test-runtime',
        source: 'wine-staging-macos',
        version: 'test',
        kind: 'wine',
        path: '/tmp',
        bin: '/bin/sh',
        installedAt: '2026-01-01T00:00:00.000Z',
        release: {
          date: '2026-01-01',
          download: 'https://example.invalid/runtime',
          notesUrl: 'https://example.invalid'
        }
      },
      ['-c', `sleep 10 & echo $! > "${childPidFile}"; exit 0`],
      { inheritStdio: false }
    )
    assert.equal(result.code, 0)
    assert.ok(performance.now() - started < 1_000)
    const childPid = Number((await readFile(childPidFile, 'utf8')).trim())
    assert.ok(Number.isInteger(childPid) && childPid > 0)

    let alive = true
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        process.kill(childPid, 0)
      } catch {
        alive = false
        break
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(alive, false, 'the child process should be gone when runRuntime returns')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('all prefixes link the same Wine username to the shared portable user directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-shared-user-'))
  const paths = portablePaths(root)
  const runtime = {
    id: 'wine-staging-macos--test',
    source: 'wine-staging-macos',
    version: 'test',
    kind: 'wine',
    path: '/tmp/runtime',
    bin: '/tmp/runtime/wine',
    installedAt: '2026-01-01T00:00:00.000Z',
    release: { date: '2026-01-01', download: 'https://example.invalid/runtime', notesUrl: 'https://example.invalid' }
  } satisfies InstalledRuntime
  try {
    const first = newContainer('first', testDefaults, paths)
    const second = newContainer('second', testDefaults, paths)
    const legacySave = join(first.prefix, 'drive_c', 'users', 'old-name', 'AppData', 'LocalLow', 'Game', 'save.dat')
    await mkdir(dirname(legacySave), { recursive: true })
    await writeFile(legacySave, 'save-data')

    await ensureSharedUserProfile(first, runtime, paths)
    await ensureSharedUserProfile(second, runtime, paths)

    const firstLink = join(first.prefix, 'drive_c', 'users', 'user')
    const secondLink = join(second.prefix, 'drive_c', 'users', 'user')
    assert.equal(resolve(dirname(firstLink), await readlink(firstLink)), paths.user)
    assert.equal(resolve(dirname(secondLink), await readlink(secondLink)), paths.user)
    assert.equal(await readFile(join(paths.user, 'AppData', 'LocalLow', 'Game', 'save.dat'), 'utf8'), 'save-data')

    await writeFile(join(firstLink, 'Documents', 'shared.txt'), 'shared')
    assert.equal(await readFile(join(secondLink, 'Documents', 'shared.txt'), 'utf8'), 'shared')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remove operations delete only portable managed data and clear the default container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-remove-'))
  const paths = portablePaths(root)
  const runtimePath = join(paths.runtimes, runtimeId('ge-proton', 'latest'))
  const componentPath = join(paths.components, 'dxvk', 'test-version')
  try {
    await mkdir(runtimePath, { recursive: true })
    await writeJson(join(runtimePath, 'runtime.json'), {
      id: runtimeId('ge-proton', 'latest'),
      source: 'ge-proton',
      version: 'latest',
      kind: 'proton',
      path: runtimePath,
      bin: join(runtimePath, 'proton'),
      installedAt: '2026-01-01T00:00:00.000Z',
      release: { date: '2026-01-01', download: 'https://example.invalid/runtime', notesUrl: 'https://example.invalid' }
    } satisfies InstalledRuntime)
    await mkdir(componentPath, { recursive: true })
    await writeJson(join(componentPath, 'component.json'), {
      name: 'dxvk',
      version: 'test-version',
      path: componentPath,
      installedAt: '2026-01-01T00:00:00.000Z',
      release: {
        date: '2026-01-01',
        download: 'https://example.invalid/component',
        notesUrl: 'https://example.invalid'
      }
    })
    await createContainer('removable', { defaults: testDefaults, initialize: false }, paths)

    assert.equal((await removeRuntime('ge-proton', 'latest', paths)).path, runtimePath)
    assert.equal((await removeComponent('dxvk', 'test-version', paths)).path, componentPath)
    const containerResult = await removeContainer('removable', paths)

    assert.equal(existsSync(runtimePath), false)
    assert.equal(existsSync(componentPath), false)
    assert.equal(existsSync(containerResult.path), false)
    assert.equal(containerResult.clearedDefault, true)
    assert.equal((await loadAppConfig(paths)).defaultContainer, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime list follows the component list convention: local by default and remote only on request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-runtime-list-'))
  const runtime = {
    id: 'ge-proton--test',
    source: 'ge-proton',
    version: 'test',
    kind: 'proton',
    path: join(root, 'runtimes', 'ge-proton--test'),
    bin: join(root, 'runtimes', 'ge-proton--test', 'proton'),
    installedAt: '2026-01-01T00:00:00.000Z',
    release: { date: '2026-01-01', download: 'https://example.invalid/runtime', notesUrl: 'https://example.invalid' }
  } satisfies InstalledRuntime
  try {
    await mkdir(runtime.path, { recursive: true })
    await writeJson(join(runtime.path, 'runtime.json'), runtime)
    const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js')
    await setCliHome(root)
    const local = await execFileAsync(process.execPath, [cli, 'runtime', 'list', '--json'])
    assert.deepEqual(JSON.parse(local.stdout), [
      { ...runtime, ignoredComponents: runtimeSources['ge-proton'].ignoredComponents }
    ])
    await assert.rejects(
      execFileAsync(process.execPath, [cli, 'runtime', 'installed']),
      /Use runtime list, runtime install, or runtime remove/
    )
  } finally {
    await setCliHome(defaultCliHome)
    await rm(root, { recursive: true, force: true })
  }
})

test('JSON installs stream progress events and report errors as JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-json-install-'))
  const runtimeSource = process.platform === 'darwin' ? 'wine-crossover' : 'ge-proton'
  const runtime = {
    id: `${runtimeSource}--test`,
    source: runtimeSource,
    version: 'test',
    kind: runtimeSource === 'ge-proton' ? 'proton' : 'crossover',
    path: join(root, 'runtimes', `${runtimeSource}--test`),
    bin:
      runtimeSource === 'ge-proton'
        ? join(root, 'runtimes', `${runtimeSource}--test`, 'proton')
        : join(root, 'runtimes', `${runtimeSource}--test`, 'Contents', 'Resources', 'wine', 'bin', 'wine64'),
    installedAt: '2026-01-01T00:00:00.000Z',
    release: { date: '2026-01-01', download: 'https://example.invalid/runtime', notesUrl: 'https://example.invalid' }
  } satisfies InstalledRuntime
  const componentPath = join(root, 'components', 'dxvk', 'test')
  try {
    await mkdir(dirname(runtime.bin), { recursive: true })
    await writeFile(runtime.bin, '')
    await writeJson(join(runtime.path, 'runtime.json'), runtime)
    await mkdir(componentPath, { recursive: true })
    await writeJson(join(componentPath, 'component.json'), {
      name: 'dxvk',
      version: 'test',
      path: componentPath,
      installedAt: '2026-01-01T00:00:00.000Z',
      release: {
        date: '2026-01-01',
        download: 'https://example.invalid/component',
        notesUrl: 'https://example.invalid'
      }
    })
    const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js')
    await setCliHome(root)
    const runtimeResult = await execFileAsync(process.execPath, [
      cli,
      'runtime',
      'install',
      runtimeSource,
      'test',
      '--json'
    ])
    const componentResult = await execFileAsync(process.execPath, [
      cli,
      'component',
      'install',
      'dxvk',
      'test',
      '--json'
    ])
    assert.deepEqual(
      runtimeResult.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        { name: runtimeSource, progress: 0 },
        { name: runtimeSource, progress: 100 }
      ]
    )
    assert.deepEqual(
      componentResult.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        { name: 'dxvk', progress: 0 },
        { name: 'dxvk', progress: 100 }
      ]
    )
    await assert.rejects(
      execFileAsync(process.execPath, [cli, 'component', 'install', 'unknown', '--json']),
      (error: { stdout?: string }) => {
        assert.deepEqual(JSON.parse(error.stdout?.trim() || ''), { error: 'Unknown component "unknown".' })
        return true
      }
    )
  } finally {
    await setCliHome(defaultCliHome)
    await rm(root, { recursive: true, force: true })
  }
})

test('build completes a partial config.json into a portable container definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-build-'))
  const paths = portablePaths(root)
  try {
    await mkdir(join(paths.containers, 'from-manifest'), { recursive: true })
    await writeJson(paths.defaults, testDefaults)
    await writeJson(containerManifestFile(paths, 'from-manifest'), {
      runtime: { version: 'custom-version' },
      components: { dxvk: { enabled: false } },
      launch: {
        enableWayland: true,
        environment: { DXVK_ASYNC: '1' }
      }
    })

    const container = await buildContainer('from-manifest', { initialize: false }, paths)

    assert.equal(container.name, 'from-manifest')
    assert.equal(container.prefix, join(paths.containers, 'from-manifest', 'prefix'))
    assert.equal(container.runtime.source, 'ge-proton')
    assert.equal(container.runtime.version, 'custom-version')
    assert.equal(container.components.dxvk.enabled, false)
    assert.equal(container.components.vkd3d.enabled, false)
    assert.equal(container.launch.enableWayland, true)
    assert.equal(container.launch.enableFsync, true)
    assert.equal(container.launch.environment.DXVK_ASYNC, '1')
    assert.equal(existsSync(join(paths.containers, 'from-manifest', 'container.json')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Proton environment mirrors Heroic compatibility variables', () => {
  const container = {
    schemaVersion: 1,
    name: 'default',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    prefix: '/tmp/prefix',
    architecture: 'win64',
    runtime: { source: 'ge-proton', version: 'GE-Proton10-1' },
    components: {
      dxvk: { enabled: true, version: 'latest' },
      dxvkNvapi: { enabled: true, version: 'latest' },
      vkd3d: { enabled: true, version: 'latest' },
      eacRuntime: { enabled: false, version: 'latest' },
      battleyeRuntime: { enabled: false, version: 'latest' }
    },
    launch: {
      enableEsync: false,
      enableFsync: false,
      enableMsync: false,
      enableWayland: true,
      enableHdr: true,
      enableWow64: true,
      showFps: false,
      dxvkFrameRate: null,
      fsr: false,
      fsrSharpness: 2,
      verboseLogs: false,
      environment: {}
    }
  } satisfies ContainerConfig
  const runtime = {
    id: 'ge-proton--GE-Proton10-1',
    source: 'ge-proton',
    version: 'GE-Proton10-1',
    kind: 'proton',
    path: '/tmp/proton',
    bin: '/tmp/proton/proton',
    installedAt: '2026-01-01T00:00:00.000Z',
    release: {
      date: '2026-01-01',
      download: 'https://example.invalid/proton.tar.gz',
      notesUrl: 'https://example.invalid'
    }
  } satisfies InstalledRuntime
  const env = buildLaunchEnvironment(container, runtime)
  assert.equal(env.STEAM_COMPAT_DATA_PATH, '/tmp/prefix')
  assert.equal(env.PROTON_NO_ESYNC, '1')
  assert.equal(env.PROTON_NO_FSYNC, '1')
  assert.equal(env.PROTON_ENABLE_WAYLAND, '1')
  assert.equal(env.PROTON_ENABLE_HDR, '1')
  assert.equal(env.PROTON_USE_WOW64, '1')
  assert.equal(env.PROTON_ENABLE_NVAPI, '1')
})

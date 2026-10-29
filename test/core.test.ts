import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { containerManifestFile, loadAppConfig, loadContainer, loadDefaults, newContainer, parseRuntimeReference, parseSetExpression, saveContainer, setAtPath } from '../src/config.js'
import { removeComponent } from '../src/components.js'
import { buildContainer, createContainer, removeContainer } from '../src/containers.js'
import { buildLaunchEnvironment, runRuntime } from '../src/launch.js'
import { isExecutableFallback } from '../src/invocation.js'
import { getPaths, readJson, writeJson } from '../src/paths.js'
import { ensureSharedUserProfile } from '../src/profile.js'
import { findRuntimeBinary, removeRuntime, runtimeId } from '../src/runtime.js'
import type { ContainerConfig, DefaultsFile, InstalledRuntime, Paths } from '../src/types.js'

const execFileAsync = promisify(execFile)

function portablePaths(root: string): Paths {
  return {
    root,
    user: join(root, 'user'),
    containers: join(root, 'containers'),
    runtimes: join(root, 'runtimes'),
    components: join(root, 'components'),
    downloads: join(root, 'downloads'),
    appConfig: join(root, 'config', 'config.json'),
    defaults: join(root, 'config', 'defaults.json'),
    bundledDefaults: join(root, 'defaults.json')
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
  const prior = process.env.WUR_HOME
  process.env.WUR_HOME = home
  try {
    const paths = getPaths()
    const defaults = await loadDefaults(paths)
    const container = newContainer('my-game', defaults, paths)
    assert.equal(container.name, 'my-game')
    assert.equal(container.prefix, join(home, 'containers', 'my-game', 'prefix'))
    assert.equal(container.components.dxvk.enabled, true)
  } finally {
    if (prior === undefined) delete process.env.WUR_HOME
    else process.env.WUR_HOME = prior
    await rm(home, { recursive: true, force: true })
  }
})

test('the compiled CLI keeps its default state beside the executable', () => {
  const prior = process.env.WUR_HOME
  delete process.env.WUR_HOME
  try {
    assert.equal(getPaths().root, resolve(process.cwd(), 'dist'))
  } finally {
    if (prior !== undefined) process.env.WUR_HOME = prior
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

test('an existing Windows-launchable file is eligible for the implicit run command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wur-invocation-'))
  const extensions = ['com', 'exe', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msc', 'pif', 'scf', 'scr']
  const directoryNamedExe = join(root, 'not-a-game.exe')
  try {
    await Promise.all(extensions.map((extension) => writeFile(join(root, `Game.${extension}`), '')))
    await mkdir(directoryNamedExe)
    for (const extension of extensions) assert.equal(isExecutableFallback(join(root, `Game.${extension}`)), true)
    assert.equal(isExecutableFallback(join(root, 'Game.EXE')), true)
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

test('runRuntime returns after its primary process exits even when a child keeps stdio open', async () => {
  const started = performance.now()
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
  const result = await runRuntime(container, {
    id: 'test-runtime',
    source: 'wine-staging-macos',
    version: 'test',
    kind: 'wine',
    path: '/tmp',
    bin: '/bin/sh',
    installedAt: '2026-01-01T00:00:00.000Z',
    release: { date: '2026-01-01', download: 'https://example.invalid/runtime', notesUrl: 'https://example.invalid' }
  }, ['-c', '(sleep 2) & exit 0'], { inheritStdio: false })
  assert.equal(result.code, 0)
  assert.ok(performance.now() - started < 1_000)
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
      release: { date: '2026-01-01', download: 'https://example.invalid/component', notesUrl: 'https://example.invalid' }
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
    const local = await execFileAsync(process.execPath, [cli, '--home', root, 'runtime', 'list', '--json'])
    assert.deepEqual(JSON.parse(local.stdout), [runtime])
    await assert.rejects(
      execFileAsync(process.execPath, [cli, '--home', root, 'runtime', 'installed']),
      /Use runtime list, runtime install, or runtime remove/
    )
  } finally {
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
    bin: runtimeSource === 'ge-proton'
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
      release: { date: '2026-01-01', download: 'https://example.invalid/component', notesUrl: 'https://example.invalid' }
    })
    const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js')
    const runtimeResult = await execFileAsync(process.execPath, [cli, '--home', root, 'runtime', 'install', runtimeSource, 'test', '--json'])
    const componentResult = await execFileAsync(process.execPath, [cli, '--home', root, 'component', 'install', 'dxvk', 'test', '--json'])
    assert.deepEqual(runtimeResult.stdout.trim().split('\n').map((line) => JSON.parse(line)), [
      { name: runtimeSource, progress: 0 },
      { name: runtimeSource, progress: 100 }
    ])
    assert.deepEqual(componentResult.stdout.trim().split('\n').map((line) => JSON.parse(line)), [
      { name: 'dxvk', progress: 0 },
      { name: 'dxvk', progress: 100 }
    ])
    await assert.rejects(
      execFileAsync(process.execPath, [cli, '--home', root, 'component', 'install', 'unknown', '--json']),
      (error: { stdout?: string }) => {
        assert.deepEqual(JSON.parse(error.stdout?.trim() || ''), { error: 'Unknown component "unknown".' })
        return true
      }
    )
  } finally {
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
    assert.equal(container.components.vkd3d.enabled, true)
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
    id: 'ge-proton--GE-Proton10-1', source: 'ge-proton', version: 'GE-Proton10-1',
    kind: 'proton', path: '/tmp/proton', bin: '/tmp/proton/proton', installedAt: '2026-01-01T00:00:00.000Z',
    release: { date: '2026-01-01', download: 'https://example.invalid/proton.tar.gz', notesUrl: 'https://example.invalid' }
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

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { containerManifestFile, loadAppConfig, loadDefaults, newContainer, parseRuntimeReference, parseSetExpression, setAtPath } from '../src/config.js'
import { removeComponent } from '../src/components.js'
import { buildContainer, createContainer, removeContainer } from '../src/containers.js'
import { buildLaunchEnvironment } from '../src/launch.js'
import { getPaths, writeJson } from '../src/paths.js'
import { findRuntimeBinary, removeRuntime, runtimeId } from '../src/runtime.js'
import type { ContainerConfig, DefaultsFile, InstalledRuntime, Paths } from '../src/types.js'

function portablePaths(root: string): Paths {
  return {
    root,
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
  const home = await mkdtemp(join(tmpdir(), 'proton-cli-test-'))
  const prior = process.env.PROTON_CLI_HOME
  process.env.PROTON_CLI_HOME = home
  try {
    const paths = getPaths()
    const defaults = await loadDefaults(paths)
    const container = newContainer('my-game', defaults, paths)
    assert.equal(container.name, 'my-game')
    assert.equal(container.prefix, join(home, 'containers', 'my-game', 'prefix'))
    assert.equal(container.components.dxvk.enabled, true)
  } finally {
    if (prior === undefined) delete process.env.PROTON_CLI_HOME
    else process.env.PROTON_CLI_HOME = prior
    await rm(home, { recursive: true, force: true })
  }
})

test('the compiled CLI keeps its default state beside the executable', () => {
  const prior = process.env.PROTON_CLI_HOME
  delete process.env.PROTON_CLI_HOME
  try {
    assert.equal(getPaths().root, resolve(process.cwd(), 'dist'))
  } finally {
    if (prior !== undefined) process.env.PROTON_CLI_HOME = prior
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

test('macOS Wine bundles use the command-line loader instead of the Finder launcher', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'proton-cli-runtime-'))
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

test('remove operations delete only portable managed data and clear the default container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proton-cli-remove-'))
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

test('build completes a partial config.json into a portable container definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proton-cli-build-'))
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

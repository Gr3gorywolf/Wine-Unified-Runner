import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { type ChildProcess, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ContainerConfig, InstalledRuntime, SpawnResult } from './types.js'

export const SHARED_WINE_USERNAME = 'user'

/**
 * `close` waits for every inherited pipe to close. Wine helper processes can
 * retain those descriptors after the game process exits, leaving a CLI stuck
 * at its final line. `exit` is the lifecycle event of the command we started.
 */
function waitForProcessExit(child: ChildProcess, errorPrefix: string, closePipes: boolean): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`${errorPrefix}: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (closePipes) {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      resolve({ code, signal })
    })
  })
}

function steamClientPath(): string {
  const configured = process.env.WUR_STEAM_ROOT || process.env.PROTON_CLI_STEAM_ROOT
  if (configured) return configured
  const choices = [
    join(homedir(), '.steam', 'steam'),
    join(homedir(), '.local', 'share', 'Steam')
  ]
  return choices.find(existsSync) || choices[0]
}

export function buildLaunchEnvironment(container: ContainerConfig, runtime: InstalledRuntime, gameId = container.name, installPath?: string): NodeJS.ProcessEnv {
  const launch = container.launch
  const customEnvironment = Object.fromEntries(
    Object.entries(launch.environment).map(([key, value]) => [key, String(value)])
  )
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...customEnvironment,
    // Keep the Windows identity stable across Wine, CrossOver, GPTK and
    // Proton. HOME intentionally remains the real host home; the portable
    // Windows profile is provided by drive_c/users/user in each prefix.
    USER: SHARED_WINE_USERNAME,
    USERNAME: SHARED_WINE_USERNAME,
    LOGNAME: SHARED_WINE_USERNAME,
    WINEPREFIX: container.prefix,
    WINE_FULLSCREEN_FSR: launch.fsr ? '1' : '0'
  }
  if (launch.fsr) environment.WINE_FULLSCREEN_FSR_STRENGTH = String(launch.fsrSharpness)
  if (launch.showFps) {
    if (process.platform === 'darwin') environment.MTL_HUD_ENABLED = '1'
    else environment.DXVK_HUD = 'fps'
  }
  if (launch.dxvkFrameRate !== null) environment.DXVK_FRAME_RATE = String(launch.dxvkFrameRate)
  if (launch.verboseLogs) {
    environment.WINEDEBUG ||= '+fixme'
    environment.DXVK_LOG_LEVEL ||= 'info'
    environment.VKD3D_DEBUG ||= 'fixme'
  }
  if (installPath && process.platform === 'linux') environment.STEAM_COMPAT_INSTALL_PATH = installPath

  if (runtime.kind === 'proton') {
    environment.STEAM_COMPAT_CLIENT_INSTALL_PATH = steamClientPath()
    environment.STEAM_COMPAT_DATA_PATH = container.prefix
    environment.PROTONPATH = runtime.path
    environment.STEAM_COMPAT_APP_ID ||= '0'
    environment.SteamAppId ||= environment.STEAM_COMPAT_APP_ID
    environment.SteamGameId ||= `wur-${gameId}`
    environment.PROTON_LOG_DIR ||= container.prefix
    if (!launch.enableEsync) environment.PROTON_NO_ESYNC = '1'
    if (!launch.enableFsync) environment.PROTON_NO_FSYNC = '1'
    if (launch.enableWayland) environment.PROTON_ENABLE_WAYLAND = '1'
    if (launch.enableWayland && launch.enableHdr) environment.PROTON_ENABLE_HDR = '1'
    if (launch.enableWow64) environment.PROTON_USE_WOW64 = '1'
    if (container.components.dxvkNvapi.enabled) {
      environment.PROTON_ENABLE_NVAPI = '1'
      environment.DXVK_NVAPI_ALLOW_OTHER_DRIVERS = '1'
    } else {
      environment.PROTON_DISABLE_NVAPI = '1'
    }
  } else {
    environment.WINEDLLOVERRIDES = environment.WINEDLLOVERRIDES
      ? `${environment.WINEDLLOVERRIDES};winemenubuilder.exe=d`
      : 'winemenubuilder.exe=d'
    if (launch.enableEsync) environment.WINEESYNC = '1'
    if (launch.enableFsync && process.platform === 'linux') environment.WINEFSYNC = '1'
    if (launch.enableMsync && process.platform === 'darwin') environment.WINEMSYNC = '1'
    if (launch.enableWayland && process.platform === 'linux') {
      environment.DISPLAY = ''
      if (launch.enableHdr) environment.DXVK_HDR = '1'
    }
    if (launch.enableWow64 && process.platform === 'linux') environment.WINEARCH = 'wow64'
    if (container.components.dxvkNvapi.enabled && process.platform === 'linux') {
      environment.DXVK_ENABLE_NVAPI = '1'
      environment.DXVK_NVAPI_ALLOW_OTHER_DRIVERS = '1'
    }
  }
  return environment
}

export async function runRuntime(
  container: ContainerConfig,
  runtime: InstalledRuntime,
  command: string[],
  options: { protonVerb?: 'run' | 'waitforexitandrun' | 'runinprefix'; cwd?: string; inheritStdio?: boolean; installPath?: string; extraEnv?: NodeJS.ProcessEnv } = {}
): Promise<SpawnResult> {
  if (!existsSync(runtime.bin)) throw new Error(`Runtime executable is missing: ${runtime.bin}`)
  const protonVerb = options.protonVerb || 'run'
  const args = runtime.kind === 'proton' ? [protonVerb, ...command] : command
  const env = { ...buildLaunchEnvironment(container, runtime, container.name, options.installPath), ...options.extraEnv }
  env.PROTON_VERB = protonVerb
  const inheritsStdio = options.inheritStdio !== false
  const child = spawn(runtime.bin, args, {
    cwd: options.cwd,
    env,
    stdio: inheritsStdio ? 'inherit' : 'pipe'
  })
  return await waitForProcessExit(child, `Could not run ${runtime.bin}`, !inheritsStdio)
}

/** Stops background Wine services for this self-contained prefix. */
export async function stopWineServer(container: ContainerConfig, runtime: InstalledRuntime): Promise<void> {
  if (!runtime.wineserver || !existsSync(runtime.wineserver)) return
  const child = spawn(runtime.wineserver, ['-k'], {
    env: buildLaunchEnvironment(container, runtime),
    stdio: 'inherit'
  })
  // wineserver returns 1 when there is no active server, which is already the
  // desired state. A cleanup failure must not mask the game's exit status.
  await waitForProcessExit(child, `Could not stop wineserver for ${container.name}`, false).catch(() => undefined)
}

export async function initializePrefix(container: ContainerConfig, runtime: InstalledRuntime): Promise<void> {
  const marker = runtime.kind === 'proton'
    ? join(container.prefix, 'pfx', 'system.reg')
    : join(container.prefix, 'system.reg')
  if (existsSync(marker)) return
  await mkdir(container.prefix, { recursive: true })
  const env = buildLaunchEnvironment(container, runtime)
  if (container.architecture === 'win32') env.WINEARCH = 'win32'
  if (container.architecture === 'wow64' && runtime.kind !== 'proton') env.WINEARCH = 'wow64'

  const args = runtime.kind === 'proton'
    ? ['run', 'wineboot', '--init']
    : ['wineboot', '--init']
  console.error(`Creating ${container.architecture} prefix for container ${container.name}…`)
  const child = spawn(runtime.bin, args, { env, stdio: 'inherit' })
  const result = await waitForProcessExit(child, 'Could not initialize prefix', false)
  if (result.code !== 0) throw new Error(`Prefix initialization failed with status ${result.code ?? result.signal}`)
  await stopWineServer(container, runtime)
}

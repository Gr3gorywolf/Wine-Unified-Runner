import { dirname, resolve } from 'node:path'
import { applyGameOverrides, hasGameLaunchOverrides, loadContainer, loadGameOverrides } from '../config.js'
import { ensureDefaultContainer, prepareContainer } from '../containers.js'
import { runRuntime, stopWineServer } from '../launch.js'
import { getPaths } from '../paths.js'
import type { RunOptions } from '../types/index.js'
import { output } from '../utils/output.js'
import { componentRuntimeEnvironment } from '../utils/runtimeEnvironment.js'

export async function runExecutable(
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

import { findInstalledComponent } from '../services/components.js'
import { getPaths } from '../services/paths.js'
import { ignoresComponent } from '../services/sources.js'
import type { ContainerConfig, InstalledRuntime } from '../types/index.js'

export async function componentRuntimeEnvironment(
  container: ContainerConfig,
  runtime: Pick<InstalledRuntime, 'source'>
): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'linux') return {}
  const paths = getPaths()
  const extra: NodeJS.ProcessEnv = {}
  if (container.components.eacRuntime.enabled && !ignoresComponent(runtime.source, 'eac-runtime')) {
    const eac = await findInstalledComponent('eac-runtime', container.components.eacRuntime.version, paths)
    if (eac) extra.PROTON_EAC_RUNTIME = eac.path
  }
  if (container.components.battleyeRuntime.enabled && !ignoresComponent(runtime.source, 'battleye-runtime')) {
    const battleye = await findInstalledComponent(
      'battleye-runtime',
      container.components.battleyeRuntime.version,
      paths
    )
    if (battleye) extra.PROTON_BATTLEYE_RUNTIME = battleye.path
  }
  return extra
}

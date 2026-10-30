import { findInstalledComponent } from '../components.js'
import { getPaths } from '../paths.js'
import type { ContainerConfig } from '../types/index.js'

export async function componentRuntimeEnvironment(container: ContainerConfig): Promise<NodeJS.ProcessEnv> {
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

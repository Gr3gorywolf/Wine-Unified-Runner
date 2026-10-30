import { loadDefaults, saveDefaults } from '../services/config.js'
import { getPaths } from '../services/paths.js'
import type { SettingsOptions } from '../types/index.js'
import { output } from '../utils/output.js'
import { parseSetExpression, setAtPath } from '../utils/settings.js'

export async function showDefaults(json: boolean): Promise<void> {
  output(await loadDefaults(getPaths()), json)
}

export async function setDefaults(options: SettingsOptions, json: boolean): Promise<void> {
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

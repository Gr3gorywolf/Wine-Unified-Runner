import { chmod, cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const bundled = resolve('dist/defaults.json')
const fallback = resolve('dist/resources/defaults.json')
const overrideTemplate = resolve('dist/wur-overrides.template.ini')
const overrideFallback = resolve('dist/resources/wur-overrides.template.ini')
await mkdir(dirname(bundled), { recursive: true })
await mkdir(dirname(fallback), { recursive: true })
await Promise.all([
  cp(resolve('resources/defaults.json'), bundled),
  cp(resolve('resources/defaults.json'), fallback),
  cp(resolve('resources/wur-overrides.template.ini'), overrideTemplate),
  cp(resolve('resources/wur-overrides.template.ini'), overrideFallback),
  chmod(resolve('dist/src/cli.js'), 0o755)
])

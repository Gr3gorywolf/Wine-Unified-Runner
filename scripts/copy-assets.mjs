import { chmod, cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const bundled = resolve('dist/defaults.json')
const fallback = resolve('dist/resources/defaults.json')
await mkdir(dirname(bundled), { recursive: true })
await mkdir(dirname(fallback), { recursive: true })
await Promise.all([
  cp(resolve('resources/defaults.json'), bundled),
  cp(resolve('resources/defaults.json'), fallback),
  chmod(resolve('dist/src/cli.js'), 0o755)
])

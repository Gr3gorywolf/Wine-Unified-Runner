import { z } from 'zod'
import type { GameOverrides } from '../types/index.js'
import { runtimeSourceSchema } from './runtime.js'

const containerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
const nonEmptyStringSchema = z.string().trim().min(1)
const iniBooleanSchema = z.preprocess((value) => {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return value
}, z.boolean())
const iniNumberSchema = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return value
}, z.number().finite())
const iniNullableNumberSchema = z.preprocess((value) => (value === 'null' ? null : value), iniNumberSchema.nullable())
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)

const optionalBoolean = iniBooleanSchema.optional().catch(undefined)
const optionalString = nonEmptyStringSchema.optional().catch(undefined)
const optionalNumber = iniNumberSchema.optional().catch(undefined)
const optionalNullableNumber = iniNullableNumberSchema.optional().catch(undefined)

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> | undefined {
  const compact = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
  return Object.keys(compact).length ? compact : undefined
}

const environmentOverridesSchema = z.record(z.string(), z.unknown()).transform((values) => {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    const entry = z.tuple([environmentNameSchema, z.coerce.string().trim().min(1)]).safeParse([name, value])
    if (entry.success) environment[entry.data[0]] = entry.data[1]
  }
  return environment
})

const runtimeOverridesSchema = z
  .object({
    source: runtimeSourceSchema.optional().catch(undefined),
    version: optionalString
  })
  .strip()
  .transform(withoutUndefined)

const componentOverridesSchema = z
  .object({
    'dxvk.enabled': optionalBoolean,
    'dxvk.version': optionalString,
    'dxvkNvapi.enabled': optionalBoolean,
    'dxvkNvapi.version': optionalString,
    'vkd3d.enabled': optionalBoolean,
    'vkd3d.version': optionalString,
    'eacRuntime.enabled': optionalBoolean,
    'eacRuntime.version': optionalString,
    'battleyeRuntime.enabled': optionalBoolean,
    'battleyeRuntime.version': optionalString
  })
  .strip()
  .transform((values) =>
    withoutUndefined({
      dxvk: withoutUndefined({ enabled: values['dxvk.enabled'], version: values['dxvk.version'] }),
      dxvkNvapi: withoutUndefined({ enabled: values['dxvkNvapi.enabled'], version: values['dxvkNvapi.version'] }),
      vkd3d: withoutUndefined({ enabled: values['vkd3d.enabled'], version: values['vkd3d.version'] }),
      eacRuntime: withoutUndefined({ enabled: values['eacRuntime.enabled'], version: values['eacRuntime.version'] }),
      battleyeRuntime: withoutUndefined({
        enabled: values['battleyeRuntime.enabled'],
        version: values['battleyeRuntime.version']
      })
    })
  )

const launchOverridesSchema = z
  .object({
    enableEsync: optionalBoolean,
    enableFsync: optionalBoolean,
    enableMsync: optionalBoolean,
    enableWayland: optionalBoolean,
    enableHdr: optionalBoolean,
    enableWow64: optionalBoolean,
    showFps: optionalBoolean,
    dxvkFrameRate: optionalNullableNumber,
    fsr: optionalBoolean,
    fsrSharpness: optionalNumber,
    verboseLogs: optionalBoolean
  })
  .strip()

/**
 * Tolerant schema for wur-overrides.ini. Unknown names and invalid values are
 * stripped, leaving only safe per-game settings to apply at launch time.
 */
export const gameOverrideIniSchema = z
  .object({
    container: z
      .object({ name: containerNameSchema.optional().catch(undefined) })
      .strip()
      .optional()
      .catch(undefined),
    runtime: runtimeOverridesSchema.optional().catch(undefined),
    components: componentOverridesSchema.optional().catch(undefined),
    launch: launchOverridesSchema.optional().catch(undefined),
    environment: environmentOverridesSchema.optional().catch(undefined)
  })
  .strip()
  .transform((input): GameOverrides => {
    const launch = withoutUndefined({
      ...input.launch,
      environment: input.environment && Object.keys(input.environment).length ? input.environment : undefined
    })
    return (
      withoutUndefined({
        containerName: input.container?.name,
        runtime: input.runtime,
        components: input.components,
        launch
      }) || {}
    )
  })
  .catch({})

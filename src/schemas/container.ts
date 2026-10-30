import { z } from 'zod'
import { containerComponentsSchema } from './components.js'
import { containerRuntimeRefSchema } from './runtime.js'

export const launchOptionsSchema = z
  .object({
    enableEsync: z.boolean(),
    enableFsync: z.boolean(),
    enableMsync: z.boolean(),
    enableWayland: z.boolean(),
    enableHdr: z.boolean(),
    enableWow64: z.boolean(),
    showFps: z.boolean(),
    dxvkFrameRate: z.number().finite().nullable(),
    fsr: z.boolean(),
    fsrSharpness: z.number().finite(),
    verboseLogs: z.boolean(),
    environment: z.record(z.string(), z.string())
  })
  .strict()

export const containerConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(64),
    createdAt: z.string(),
    updatedAt: z.string(),
    prefix: z.string().min(1),
    architecture: z.enum(['win32', 'win64', 'wow64']),
    runtime: containerRuntimeRefSchema,
    components: containerComponentsSchema,
    launch: launchOptionsSchema
  })
  .strict()

export const defaultsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    container: z
      .object({
        architecture: z.enum(['win32', 'win64', 'wow64']),
        runtime: containerRuntimeRefSchema,
        components: containerComponentsSchema,
        launch: launchOptionsSchema
      })
      .strict()
  })
  .strict()

export const appConfigSchema = z
  .object({ schemaVersion: z.literal(1), defaultContainer: z.string().optional() })
  .strict()

const partialSelection = z.object({ enabled: z.boolean().optional(), version: z.string().min(1).optional() }).strict()
const partialComponents = z
  .object({
    dxvk: partialSelection.optional(),
    dxvkNvapi: partialSelection.optional(),
    vkd3d: partialSelection.optional(),
    eacRuntime: partialSelection.optional(),
    battleyeRuntime: partialSelection.optional()
  })
  .strict()
const partialLaunch = z
  .object({
    enableEsync: z.boolean().optional(),
    enableFsync: z.boolean().optional(),
    enableMsync: z.boolean().optional(),
    enableWayland: z.boolean().optional(),
    enableHdr: z.boolean().optional(),
    enableWow64: z.boolean().optional(),
    showFps: z.boolean().optional(),
    dxvkFrameRate: z.number().finite().nullable().optional(),
    fsr: z.boolean().optional(),
    fsrSharpness: z.number().finite().optional(),
    verboseLogs: z.boolean().optional(),
    environment: z.record(z.string(), z.string()).optional()
  })
  .strict()

export const gameOverridesSchema = z
  .object({
    containerName: z.string().min(1).max(64).optional(),
    runtime: z
      .object({ source: containerRuntimeRefSchema.shape.source.optional(), version: z.string().min(1).optional() })
      .strict()
      .optional(),
    components: partialComponents.partial().optional(),
    launch: partialLaunch.optional()
  })
  .strict()

export const containerManifestSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    runtime: z
      .object({ source: containerRuntimeRefSchema.shape.source.optional(), version: z.string().min(1).optional() })
      .strict()
      .optional(),
    architecture: z.enum(['win32', 'win64', 'wow64']).optional(),
    components: partialComponents.optional(),
    launch: partialLaunch.optional()
  })
  .strict()

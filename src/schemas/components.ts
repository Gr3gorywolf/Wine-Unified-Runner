import { z } from 'zod'

export const componentNameSchema = z.enum(['dxvk', 'dxvk-nvapi', 'vkd3d', 'dxvk-macos', 'dxmt', 'eac-runtime', 'battleye-runtime', 'umu'])
export const componentSelectionSchema = z.object({ enabled: z.boolean(), version: z.string().min(1) }).strict()
export const containerComponentsSchema = z.object({
  dxvk: componentSelectionSchema,
  dxvkNvapi: componentSelectionSchema,
  vkd3d: componentSelectionSchema,
  eacRuntime: componentSelectionSchema,
  battleyeRuntime: componentSelectionSchema
}).strict()

export const componentReleaseSchema = z.object({
  name: componentNameSchema,
  version: z.string().min(1),
  date: z.string(),
  download: z.string().url(),
  size: z.number().nonnegative(),
  notesUrl: z.string().url(),
  stripComponents: z.number().int().nonnegative()
}).strict()

export const installedComponentSchema = z.object({
  name: componentNameSchema,
  version: z.string().min(1),
  path: z.string().min(1),
  installedAt: z.string(),
  release: z.object({ date: z.string(), download: z.string().url(), notesUrl: z.string().url() }).strict()
}).strict()

import { z } from 'zod'

export const runtimeSourceSchema = z.enum([
  'ge-proton', 'proton', 'proton-cachyos', 'wine-lutris',
  'wine-crossover', 'wine-staging-macos', 'game-porting-toolkit'
])

export const runtimeKindSchema = z.enum(['proton', 'wine', 'toolkit', 'crossover'])
export const containerRuntimeRefSchema = z.object({
  source: runtimeSourceSchema,
  version: z.string().min(1)
}).strict()

export const runtimeReleaseSchema = z.object({
  source: runtimeSourceSchema,
  version: z.string().min(1),
  date: z.string(),
  download: z.string().url(),
  size: z.number().nonnegative(),
  checksum: z.string().optional(),
  notesUrl: z.string().url(),
  latest: z.boolean().optional()
}).strict()

export const installedRuntimeSchema = z.object({
  id: z.string().min(1),
  source: runtimeSourceSchema,
  version: z.string().min(1),
  kind: runtimeKindSchema,
  path: z.string().min(1),
  bin: z.string().min(1),
  wineserver: z.string().optional(),
  installedAt: z.string(),
  release: z.object({ date: z.string(), download: z.string().url(), notesUrl: z.string().url() }).strict()
}).strict()

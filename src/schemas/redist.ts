import { z } from 'zod'

export const redistCacheSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    assetName: z.string().min(1),
    downloadedAt: z.string(),
    release: z.object({ date: z.string(), download: z.string().url(), notesUrl: z.string().url() }).strict()
  })
  .strict()

export const redistReleaseSchema = z
  .object({
    version: z.string().min(1),
    date: z.string(),
    download: z.string().url(),
    notesUrl: z.string().url(),
    assetName: z.string().min(1)
  })
  .strict()

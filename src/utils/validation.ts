import { z } from 'zod'

/** Formats Zod's structured issues into a stable CLI-friendly message. */
export function formatZodError(error: z.ZodError, origin: string): Error {
  const details = error.issues.map((issue) => {
    const path = issue.path.length ? `.${issue.path.join('.')}` : ''
    return `${origin}${path}: ${issue.message}`
  }).join('; ')
  return new Error(details || `${origin}: invalid value`)
}

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, origin: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw formatZodError(result.error, origin)
  return result.data
}

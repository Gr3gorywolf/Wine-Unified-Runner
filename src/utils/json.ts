import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { parseWithSchema } from './validation.js'

export async function readValidatedJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read JSON file ${file}: ${message}`)
  }
  return parseWithSchema(schema, value, file)
}

export async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read JSON file ${file}: ${message}`)
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

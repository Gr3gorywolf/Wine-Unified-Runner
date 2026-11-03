import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import lodash from 'lodash'
import { z } from 'zod'
import { gameOverridesSchema } from '../schemas/index.js'
import type { GameOverrides } from '../types/index.js'
import { parseDotPath, parseSetExpression } from './settings.js'

export const GAME_OVERRIDE_FILE = 'wur-overrides.jsonc'

type JsonPrimitive = string | number | boolean | null

interface GameOverrideAssignment {
  path: string[]
  value?: JsonPrimitive
}

const overridePaths = collectOverridePaths(gameOverridesSchema)

/** Parses the editable JSONC sidecar with the game override schema. */
export function parseGameOverrides(contents: string): GameOverrides {
  const parsed = gameOverridesSchema.safeParse(parseJsonc(contents))
  if (!parsed.success) return {}
  return (compactEmptyObjects(parsed.data) as GameOverrides | undefined) ?? {}
}

/** Validates a complete --val path against gameOverridesSchema. */
export function parseGameOverrideAssignment(expression: string): GameOverrideAssignment {
  const { path: key, value } = parseSetExpression(expression)
  const path = parseDotPath(key)
  if (!isOverridePath(path)) throw new Error(`Unknown override key "${key}".`)
  if (expression.indexOf('=') === expression.length - 1) return { path }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) {
    throw new Error(`Override value for "${key}" must be a string, number, boolean, or null.`)
  }

  const normalized = normalizedValue(path, value)
  if (normalized === undefined) throw new Error(`Invalid override "${expression}".`)
  return { path, value: normalized }
}

function collectOverridePaths(schema: z.ZodType): Set<string> {
  const paths = new Set<string>()

  function visit(node: z.ZodType, path: string[]): void {
    const unwrapped = unwrap(node)
    if (unwrapped instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(unwrapped.shape)) visit(child, [...path, key])
    } else if (unwrapped instanceof z.ZodRecord) {
      paths.add([...path, '*'].join('.'))
    } else {
      paths.add(path.join('.'))
    }
  }

  visit(schema, [])
  return paths
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
    current = current.unwrap() as z.ZodType
  }
  return current
}

function isOverridePath(path: string[]): boolean {
  const exactPath = path.join('.')
  const recordPath = [...path.slice(0, -1), '*'].join('.')
  return overridePaths.has(exactPath) || overridePaths.has(recordPath)
}

/** Applies JSONC edits without discarding comments or unrelated formatting. */
export function applyGameOverrideAssignments(contents: string, assignments: GameOverrideAssignment[]): string {
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n'
  let updated = contents
  for (const { path, value } of assignments) {
    updated = editJsonc(updated, path, value, lineEnding)
    if (value === undefined) updated = removeEmptyParents(updated, path, lineEnding)
  }
  return updated
}

function normalizedValue(path: string[], value: JsonPrimitive): JsonPrimitive | undefined {
  if (gameOverridesSchema.safeParse(valueAtPath(path, value)).success) return value
  const asString = String(value)
  return gameOverridesSchema.safeParse(valueAtPath(path, asString)).success ? asString : undefined
}

function valueAtPath(path: string[], value: JsonPrimitive): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  lodash.set(result, path, value)
  return result
}

function editJsonc(contents: string, path: string[], value: JsonPrimitive | undefined, lineEnding: string): string {
  const edits = modify(contents, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: lineEnding }
  })
  return applyEdits(contents, edits)
}

function removeEmptyParents(contents: string, path: string[], lineEnding: string): string {
  let updated = contents
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parentPath = path.slice(0, depth)
    const parent = lodash.get(parseJsonc(updated), parentPath)
    if (!isEmptyObject(parent)) break
    updated = editJsonc(updated, parentPath, undefined, lineEnding)
  }
  return updated
}

function parseJsonc(contents: string): unknown {
  const errors: ParseError[] = []
  const value = parse(contents, errors, { allowTrailingComma: true, disallowComments: false })
  return errors.length ? undefined : value
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEmptyObject(value: unknown): boolean {
  return isJsonObject(value) && Object.keys(value).length === 0
}

function compactEmptyObjects(value: unknown): unknown {
  if (!isJsonObject(value)) return value
  const compact: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const compactChild = compactEmptyObjects(child)
    if (compactChild !== undefined) compact[key] = compactChild
  }
  return Object.keys(compact).length ? compact : undefined
}

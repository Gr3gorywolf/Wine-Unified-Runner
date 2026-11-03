import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import lodash from 'lodash'
import { z } from 'zod'
import { gameOverridesSchema } from '../schemas/index.js'
import type { GameOverrides } from '../types/index.js'
import { parseDotPath, parseSetExpression } from './settings.js'

export const GAME_OVERRIDE_FILE = 'wur-overrides.jsonc'

type JsonPrimitive = string | number | boolean | null

export interface GameOverrideAssignment {
  path: string[]
  value?: JsonPrimitive
  remove: boolean
}

interface DynamicOverridePath {
  path: string[]
  schema: z.ZodRecord
}

const { staticPaths: staticOverridePaths, dynamicPaths: dynamicOverridePaths } = buildOverridePaths(gameOverridesSchema)

/** Parses the editable JSONC sidecar using the same schema as runtime overrides. */
export function parseGameOverrides(contents: string, _origin?: string): GameOverrides {
  const errors: ParseError[] = []
  const raw = parse(contents, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) return {}
  const parsed = gameOverridesSchema.safeParse(raw)
  if (!parsed.success) return {}
  const compact = compactEmptyObjects(parsed.data)
  return compact && typeof compact === 'object' && !Array.isArray(compact) ? (compact as GameOverrides) : {}
}

/** Validates a complete --val path against gameOverridesSchema. */
export function parseGameOverrideAssignment(expression: string): GameOverrideAssignment {
  const { path: key, value } = parseSetExpression(expression)
  const path = parseDotPath(key)
  if (!isOverridePath(path)) throw new Error(`Unknown override key "${key}".`)
  if (expression.slice(expression.indexOf('=') + 1) === '') return { path, remove: true }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) {
    throw new Error(`Override value for "${key}" must be a string, number, boolean, or null.`)
  }

  const normalized = normalizedValue(path, value)
  if (normalized === undefined) throw new Error(`Invalid override "${expression}".`)
  return { path, value: normalized, remove: false }
}

function buildOverridePaths(schema: z.ZodType): {
  staticPaths: Set<string>
  dynamicPaths: DynamicOverridePath[]
} {
  const staticPaths = new Set<string>()
  const dynamicPaths: DynamicOverridePath[] = []

  function visit(node: z.ZodType, path: string[]): void {
    const unwrapped = unwrap(node)
    if (unwrapped instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(unwrapped.shape)) visit(child, [...path, key])
    } else if (unwrapped instanceof z.ZodRecord) {
      dynamicPaths.push({ path, schema: unwrapped })
    } else {
      staticPaths.add(path.join('.'))
    }
  }

  visit(schema, [])
  return { staticPaths, dynamicPaths }
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
    current = current.unwrap() as z.ZodType
  }
  return current
}

function isOverridePath(path: string[]): boolean {
  if (staticOverridePaths.has(path.join('.'))) return true
  const parent = path.slice(0, -1)
  const key = path.at(-1)
  if (!key) return false
  return dynamicOverridePaths.some(
    (dynamic) => lodash.isEqual(dynamic.path, parent) && recordAcceptsKey(dynamic.schema, key)
  )
}

function recordAcceptsKey(schema: z.ZodRecord, key: string): boolean {
  const parsed = schema.safeParse({ [key]: '__wur_key_probe__' })
  return parsed.success && Object.hasOwn(parsed.data, key)
}

/** Applies JSONC edits without discarding comments or unrelated formatting. */
export function applyGameOverrideAssignments(contents: string, assignments: GameOverrideAssignment[]): string {
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n'
  return assignments.reduce((updated, assignment) => {
    const edits = modify(updated, assignment.path, assignment.remove ? undefined : assignment.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: lineEnding }
    })
    const edited = applyEdits(updated, edits)
    return assignment.remove ? removeEmptyParents(edited, assignment.path, lineEnding) : edited
  }, contents)
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

function removeEmptyParents(contents: string, path: string[], lineEnding: string): string {
  let updated = contents
  for (let depth = path.length - 1; depth > 0; depth--) {
    const errors: ParseError[] = []
    const raw = parse(updated, errors, { allowTrailingComma: true, disallowComments: false })
    const parent = errors.length ? undefined : valueAt(raw, path.slice(0, depth))
    if (!isEmptyObject(parent)) break
    updated = applyEdits(
      updated,
      modify(updated, path.slice(0, depth), undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: lineEnding }
      })
    )
  }
  return updated
}

function valueAt(value: unknown, path: string[]): unknown {
  return lodash.get(value, path)
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}

function compactEmptyObjects(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const compact = Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, compactEmptyObjects(child)] as const)
      .filter(([, child]) => child !== undefined)
  )
  return Object.keys(compact).length ? compact : undefined
}

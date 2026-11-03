import lodash from 'lodash'
import type { ContainerConfig } from '../types/index.js'

const safeJsonPathSegment = /^[A-Za-z_][A-Za-z0-9_]*$/
const forbiddenPathSegments = new Set(['__proto__', 'constructor', 'prototype'])

export function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  lodash.set(target, parseDotPath(path), value)
}

export function parseDotPath(path: string): string[] {
  const parts = lodash.toPath(path)
  if (
    !parts.length ||
    parts.join('.') !== path ||
    !parts.every((part) => safeJsonPathSegment.test(part) && !forbiddenPathSegments.has(part))
  ) {
    throw new Error(`Invalid JSON path "${path}".`)
  }
  return parts
}

export function parseSetExpression(expression: string): { path: string; value: unknown } {
  const equals = expression.indexOf('=')
  if (equals < 1) throw new Error(`Expected path=value, received "${expression}".`)
  return { path: expression.slice(0, equals), value: parseJsonValue(expression.slice(equals + 1)) }
}

export function applySettings(container: ContainerConfig, expressions: string[]): void {
  for (const expression of expressions) {
    const { path, value } = parseSetExpression(expression)
    setAtPath(container as unknown as Record<string, unknown>, path, value)
  }
}

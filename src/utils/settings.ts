import type { ContainerConfig } from '../types/index.js'

export function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  if (!parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) throw new Error(`Invalid JSON path "${path}".`)
  let cursor: Record<string, unknown> = target
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts.at(-1)!] = value
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

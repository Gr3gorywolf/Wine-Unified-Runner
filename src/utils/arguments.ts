import { InvalidArgumentError } from 'commander'

/** Commander parser for options which may be specified more than once. */
export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

/** Commander parser for positive integer option values such as --limit. */
export function positiveInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('Expected a positive integer.')
  return parsed
}

function firstCommandToken(argv: string[]): string | undefined {
  let skipNext = false
  for (const token of argv) {
    if (token === '--') break
    if (skipNext) {
      skipNext = false
      continue
    }
    if (token === '--json') continue
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

/** Inserts the native `run` command for the documented `wur GAME.exe` form. */
export function normalizeExecutableFallback(argv: string[], isExecutable: (value: string) => boolean): string[] {
  const candidate = firstCommandToken(argv)
  if (!candidate || !isExecutable(candidate)) return argv
  const index = argv.indexOf(candidate)
  return [...argv.slice(0, index), 'run', ...argv.slice(index)]
}

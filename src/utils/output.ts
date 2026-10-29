import pc from 'picocolors'

export const colors = pc

export function output(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (Array.isArray(value)) {
    if (!value.length) return console.log('No entries found.')
    console.table(value)
    return
  }
  if (typeof value === 'object') console.log(JSON.stringify(value, null, 2))
  else console.log(value)
}

export function installProgressReporter(name: string): (progress: number) => void {
  let lastProgress = -1
  return (progress) => {
    const normalized = Math.min(100, Math.max(0, Math.floor(progress)))
    if (normalized === lastProgress) return
    lastProgress = normalized
    console.log(JSON.stringify({ name, progress: normalized }))
  }
}

export function formatBytes(value: number): string {
  if (!value) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let index = 0
  let amount = value
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++ }
  return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`
}

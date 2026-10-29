import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { spawn } from 'node:child_process'

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wur-wine-unified-runner'
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`)
  return await response.json() as T
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`)
  return await response.text()
}

export interface DownloadOptions {
  onProgress?: (progress: number) => void
  quiet?: boolean
}

export async function downloadFile(
  url: string,
  destination: string,
  label = basename(new URL(url).pathname),
  options: DownloadOptions = {}
): Promise<string> {
  await mkdir(dirname(destination), { recursive: true })
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`)

  const total = Number(response.headers.get('content-length') || 0)
  const hash = createHash('sha512')
  const stream = createWriteStream(destination)
  let received = 0
  let lastReport = 0
  let lastProgress = -1
  let streamFailure: Error | undefined
  const reportProgress = (progress: number) => {
    const normalized = Math.min(100, Math.max(0, Math.floor(progress)))
    if (normalized === lastProgress) return
    lastProgress = normalized
    options.onProgress?.(normalized)
  }
  reportProgress(0)
  stream.on('error', (error) => { streamFailure ||= error })
  try {
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (streamFailure) throw streamFailure
      const chunk = Buffer.from(part)
      received += chunk.length
      hash.update(chunk)
      if (!stream.write(chunk)) await new Promise<void>((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve() }
        const onError = (error: Error) => { cleanup(); reject(error) }
        const cleanup = () => {
          stream.removeListener('drain', onDrain)
          stream.removeListener('error', onError)
        }
        stream.once('drain', onDrain)
        stream.once('error', onError)
      })
      if (total) reportProgress(received / total * 100)
      if (!options.quiet && process.stderr.isTTY && Date.now() - lastReport > 400) {
        const progress = total ? ` ${(received / total * 100).toFixed(1)}%` : ` ${(received / 1024 / 1024).toFixed(1)} MiB`
        process.stderr.write(`\rDownloading ${label}:${progress}`)
        lastReport = Date.now()
      }
    }
    if (streamFailure) throw streamFailure
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { cleanup(); reject(error) }
      const cleanup = () => stream.removeListener('error', onError)
      stream.once('error', onError)
      stream.end(() => { cleanup(); resolve() })
    })
    reportProgress(100)
    if (!options.quiet && process.stderr.isTTY) process.stderr.write(`\rDownloading ${label}: done${' '.repeat(12)}\n`)
    return hash.digest('hex')
  } catch (error) {
    stream.destroy()
    await rm(destination, { force: true })
    throw error
  }
}

export async function verifySha512(checksumUrl: string, digest: string): Promise<void> {
  const checksums = await fetchText(checksumUrl)
  if (!checksums.toLowerCase().includes(digest.toLowerCase())) {
    throw new Error(`SHA-512 verification failed against ${checksumUrl}`)
  }
}

export async function extractArchive(archive: string, destination: string, stripComponents = 1, quiet = false): Promise<void> {
  await mkdir(destination, { recursive: true })
  const args = ['-xf', archive, '-C', destination]
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args, { stdio: quiet ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'inherit', 'inherit'] })
    let stderr = ''
    if (quiet) child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => reject(new Error(`Could not start tar: ${error.message}`)))
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with status ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)))
  })
}

export async function sha512File(file: string): Promise<string> {
  return createHash('sha512').update(await readFile(file)).digest('hex')
}

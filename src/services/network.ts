import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import axios from 'axios'
import type { DownloadOptions } from '../types/index.js'

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wur-wine-unified-runner'
}

export async function fetchJson<T>(url: string): Promise<T> {
  try {
    const response = await axios.get<T>(url, { headers })
    return response.data
  } catch (error) {
    throw requestError(error, url)
  }
}

export async function fetchText(url: string): Promise<string> {
  try {
    const response = await axios.get<string>(url, { headers, responseType: 'text' })
    return response.data
  } catch (error) {
    throw requestError(error, url)
  }
}

function requestError(error: unknown, url: string): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 'network error'
    return new Error(`Request failed (${status}) for ${url}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

export async function downloadFile(
  url: string,
  destination: string,
  label = basename(new URL(url).pathname),
  options: DownloadOptions = {}
): Promise<string> {
  await mkdir(dirname(destination), { recursive: true })
  const response = await axios.get<NodeJS.ReadableStream>(url, {
    headers,
    responseType: 'stream',
    maxRedirects: 5,
    validateStatus: () => true
  })
  if (response.status < 200 || response.status >= 300 || !response.data) {
    throw new Error(`Download failed (${response.status}) for ${url}`)
  }

  const total = Number(response.headers['content-length'] || 0)
  const hash = createHash('sha512')
  let received = 0
  let lastReport = 0
  let lastProgress = -1
  const reportProgress = (progress: number) => {
    const normalized = Math.min(100, Math.max(0, Math.floor(progress)))
    if (normalized === lastProgress) return
    lastProgress = normalized
    options.onProgress?.(normalized)
  }
  reportProgress(0)
  const tracker = new PassThrough()
  tracker.on('data', (chunk: Buffer) => {
    received += chunk.length
    hash.update(chunk)
    if (total) reportProgress((received / total) * 100)
    if (!options.quiet && process.stderr.isTTY && Date.now() - lastReport > 400) {
      const progress = total
        ? ` ${((received / total) * 100).toFixed(1)}%`
        : ` ${(received / 1024 / 1024).toFixed(1)} MiB`
      process.stderr.write(`\rDownloading ${label}:${progress}`)
      lastReport = Date.now()
    }
  })
  try {
    await pipeline(response.data, tracker, createWriteStream(destination))
    reportProgress(100)
    if (!options.quiet && process.stderr.isTTY) process.stderr.write(`\rDownloading ${label}: done${' '.repeat(12)}\n`)
    return hash.digest('hex')
  } catch (error) {
    await rm(destination, { force: true })
    if (axios.isAxiosError(error)) throw new Error(`Download failed for ${url}: ${error.message}`)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function verifySha512(checksumUrl: string, digest: string): Promise<void> {
  const checksums = await fetchText(checksumUrl)
  if (!checksums.toLowerCase().includes(digest.toLowerCase())) {
    throw new Error(`SHA-512 verification failed against ${checksumUrl}`)
  }
}

export async function extractArchive(
  archive: string,
  destination: string,
  stripComponents = 1,
  quiet = false
): Promise<void> {
  await mkdir(destination, { recursive: true })
  const args = ['-xf', archive, '-C', destination]
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args, { stdio: quiet ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'inherit', 'inherit'] })
    let stderr = ''
    if (quiet)
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
    child.once('error', (error) => reject(new Error(`Could not start tar: ${error.message}`)))
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar exited with status ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    )
  })
}

/** Extracts a ZIP archive with the platform's standard unzip implementation. */
export async function extractZip(archive: string, destination: string, quiet = false): Promise<void> {
  await mkdir(destination, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', [quiet ? '-q' : '', archive, '-d', destination].filter(Boolean), {
      stdio: quiet ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'inherit', 'inherit']
    })
    let stderr = ''
    if (quiet)
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
    child.once('error', (error) => reject(new Error(`Could not start unzip: ${error.message}`)))
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`unzip exited with status ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    )
  })
}

export async function sha512File(file: string): Promise<string> {
  return createHash('sha512')
    .update(await readFile(file))
    .digest('hex')
}

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { get } from 'node:https'
import { arch, platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')
const buildRoot = join(projectRoot, '.build', 'binary')
const cacheRoot = join(projectRoot, '.cache', 'node-binaries')
const releaseRoot = join(projectRoot, 'release')
const outputBinary = join(releaseRoot, platform() === 'win32' ? 'wur.exe' : 'wur')
const legacyOutputBinary = join(releaseRoot, platform() === 'win32' ? 'proton-cli.exe' : 'proton-cli')
const nodeVersion = process.env.WUR_NODE_VERSION || process.env.PROTON_CLI_NODE_VERSION || '22.23.4'
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

function fail(message) {
  throw new Error(message)
}

function parseBuildArguments(args) {
  let clean = false
  for (const argument of args) {
    if (argument === '--clean') {
      clean = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: npm run build-binary -- [--clean]')
      process.exit(0)
    }
    fail(`Unknown build-binary option: ${argument}. Use --clean to remove the entire release folder.`)
  }
  return { clean }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      ...options
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${basename(command)} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`))
    })
  })
}

function download(url, destination, redirects = 0) {
  return new Promise((resolvePromise, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        if (redirects >= 5) {
          reject(new Error(`Too many redirects while downloading ${url}.`))
          return
        }
        const redirected = new URL(response.headers.location, url).toString()
        download(redirected, destination, redirects + 1).then(resolvePromise, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Could not download ${url}: HTTP ${response.statusCode}.`))
        return
      }
      pipeline(response, createWriteStream(destination)).then(resolvePromise, reject)
    })
    request.once('error', reject)
  })
}

async function ensureDownloaded(url, destination) {
  try {
    await access(destination)
    return
  } catch {
    // Cache miss.
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.tmp`
  console.log(`Downloading ${url}`)
  try {
    await download(url, temporary)
    await copyFile(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  const content = await readFile(file)
  hash.update(content)
  return hash.digest('hex')
}

async function nodeArchive(targetPlatform, targetArch) {
  const nodePlatform = targetPlatform === 'darwin' ? 'darwin' : 'linux'
  const extension = nodePlatform === 'darwin' ? 'tar.gz' : 'tar.xz'
  const filename = `node-v${nodeVersion}-${nodePlatform}-${targetArch}.${extension}`
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`
  const archive = join(cacheRoot, filename)
  const sums = join(cacheRoot, `SHASUMS256-v${nodeVersion}.txt`)
  await ensureDownloaded(`${baseUrl}/${filename}`, archive)
  await ensureDownloaded(`${baseUrl}/SHASUMS256.txt`, sums)

  const entry = (await readFile(sums, 'utf8'))
    .split(/\r?\n/u)
    .find((line) => line.trim().endsWith(`  ${filename}`))
  if (!entry) fail(`Node.js did not publish a checksum for ${filename}.`)
  const expected = entry.trim().split(/\s+/u)[0]
  const actual = await sha256(archive)
  if (actual !== expected) fail(`SHA-256 mismatch for ${filename}. Delete ${archive} and try again.`)
  return { archive, filename }
}

async function extractNode(targetPlatform, targetArch) {
  const { archive } = await nodeArchive(targetPlatform, targetArch)
  const destination = join(buildRoot, `node-${targetPlatform}-${targetArch}`)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await run('tar', ['-xf', archive, '-C', destination, '--strip-components=1'])
  return join(destination, 'bin', 'node')
}

async function injectSea(sourceNode, destination, blob, targetPlatform) {
  await copyFile(sourceNode, destination)
  await chmod(destination, 0o755)
  if (targetPlatform === 'darwin') {
    await run('/usr/bin/codesign', ['--remove-signature', destination])
  }
  const postject = join(projectRoot, 'node_modules', '.bin', 'postject')
  const args = [
    destination,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    seaFuse
  ]
  if (targetPlatform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA')
  await run(postject, args)
}

function linuxNodeArchitecture(hostArch) {
  const mapping = {
    arm: 'armv7l',
    arm64: 'arm64',
    ppc64: 'ppc64le',
    s390x: 's390x',
    x64: 'x64'
  }
  const result = mapping[hostArch]
  if (!result) fail(`Linux architecture ${hostArch} is not published by Node.js ${nodeVersion}.`)
  return result
}

async function main() {
  const { clean } = parseBuildArguments(process.argv.slice(2))
  if (platform() !== 'darwin' && platform() !== 'linux') {
    fail(`build-binary currently supports macOS and Linux; detected ${platform()}.`)
  }

  await rm(buildRoot, { recursive: true, force: true })
  // Always remove the previous executable so lipo/postject never operate on a
  // stale binary. The portable state around it is preserved by default.
  await rm(outputBinary, { force: true })
  // Clean up the former public binary name without touching portable state.
  await rm(legacyOutputBinary, { force: true })
  if (clean) await rm(releaseRoot, { recursive: true, force: true })
  await mkdir(buildRoot, { recursive: true })
  await mkdir(releaseRoot, { recursive: true })

  const bundle = join(buildRoot, 'wur.cjs')
  await build({
    entryPoints: [join(projectRoot, 'src', 'cli.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    minifySyntax: true,
    define: {
      __WUR_STANDALONE__: 'true',
      // The standalone branch uses process.execPath. Replacing the unused ESM
      // value also prevents a misleading CJS-format warning from esbuild.
      'import.meta.url': JSON.stringify('file:///standalone')
    }
  })

  const targetArch = platform() === 'darwin' ? (arch() === 'x64' ? 'x64' : 'arm64') : linuxNodeArchitecture(arch())
  const generatorNode = await extractNode(platform(), targetArch)
  const blob = join(buildRoot, 'sea-prep.blob')
  const seaConfig = join(buildRoot, 'sea-config.json')
  await writeFile(seaConfig, `${JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: 'none'
  }, null, 2)}\n`, 'utf8')
  await run(generatorNode, ['--experimental-sea-config', seaConfig])

  if (platform() === 'darwin') {
    const armNode = targetArch === 'arm64' ? generatorNode : await extractNode('darwin', 'arm64')
    const x64Node = targetArch === 'x64' ? generatorNode : await extractNode('darwin', 'x64')
    const armBinary = join(buildRoot, 'wur-arm64')
    const x64Binary = join(buildRoot, 'wur-x64')
    await injectSea(armNode, armBinary, blob, 'darwin')
    await injectSea(x64Node, x64Binary, blob, 'darwin')
    await run('/usr/bin/lipo', ['-create', armBinary, x64Binary, '-output', outputBinary])
    await chmod(outputBinary, 0o755)
    await run('/usr/bin/codesign', ['--force', '--sign', '-', outputBinary])
    await run('/usr/bin/lipo', [outputBinary, '-verify_arch', 'arm64', 'x86_64'])
  } else {
    await injectSea(generatorNode, outputBinary, blob, 'linux')
  }

  await copyFile(join(projectRoot, 'resources', 'defaults.json'), join(releaseRoot, 'defaults.json'))
  await copyFile(join(projectRoot, 'resources', 'wur-overrides.template.ini'), join(releaseRoot, 'wur-overrides.template.ini'))
  await run(outputBinary, ['--help'])
  console.log(`\nStandalone CLI created at ${outputBinary}`)
  if (!clean) console.log('Existing portable state in release/ was preserved.')
  console.log('Node.js is embedded; the destination system does not need Node.js installed.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

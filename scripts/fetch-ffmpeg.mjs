#!/usr/bin/env node
/**
 * Fetches the ffmpeg binary for a target platform.
 *
 * `ffmpeg-static` downloads one binary at install time, chosen by the machine
 * doing the installing. That is fine until you cross-build: packaging for
 * Windows on a Mac would otherwise bundle a Mach-O executable, and the app
 * would look for `ffmpeg.exe` at runtime and find nothing — remuxing, HLS and
 * embedded-subtitle extraction would all fail on the shipped build with no
 * hint as to why.
 *
 * So each target gets its own binary, staged under build/ffmpeg/ and copied
 * into the app by electron-builder's per-platform extraResources.
 *
 *   node scripts/fetch-ffmpeg.mjs darwin arm64
 *   node scripts/fetch-ffmpeg.mjs win32 x64
 *   node scripts/fetch-ffmpeg.mjs linux x64
 */
import { createWriteStream, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))

// Pin to whatever release the installed ffmpeg-static agrees with, so the
// cross-built binaries are the same build as the local one.
const pkg = require('../node_modules/ffmpeg-static/package.json')
const TAG = pkg['ffmpeg-static']['binary-release-tag']
const BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download'

const [platform, arch] = process.argv.slice(2)
if (!platform || !arch) {
  console.error('usage: fetch-ffmpeg.mjs <platform> <arch>')
  process.exit(1)
}

const dest = join(root, 'build', 'ffmpeg', `${platform}-${arch}`)
const file = join(dest, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

if (existsSync(file)) {
  console.log(`ffmpeg ${platform}-${arch}: already staged (${(statSync(file).size / 1048576).toFixed(0)} MB)`)
  process.exit(0)
}

mkdirSync(dest, { recursive: true })

const url = `${BASE}/${TAG}/ffmpeg-${platform}-${arch}.gz`
console.log(`fetching ${url}`)

const res = await fetch(url, { redirect: 'follow' })
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`)
  process.exit(1)
}

await pipeline(res.body, createGunzip(), createWriteStream(file))
chmodSync(file, 0o755)

console.log(`ffmpeg ${platform}-${arch}: ${(statSync(file).size / 1048576).toFixed(0)} MB -> ${file.replace(root, '')}`)

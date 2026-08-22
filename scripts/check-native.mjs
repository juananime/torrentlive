#!/usr/bin/env node
/**
 * Guards the "runs natively on Apple Silicon, no Rosetta" promise.
 *
 * Rosetta gets pulled in when the app loads a compiled .node addon built for
 * x86_64. What matters is only the addons this platform would actually load —
 * a linux-x64 or win32-x64 prebuild sitting in the tree is inert on macOS, so
 * flagging it would be noise. This script therefore checks, per package:
 *
 *   1. does it ship a darwin-arm64 (or universal) prebuild?  -> fine
 *   2. did it compile something into build/Release?          -> check its arch
 *   3. is the only macOS binary it has x86_64?               -> Rosetta risk
 *
 * Run: npm run check:native
 */
import { readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const modules = join(root, 'node_modules')

if (!existsSync(modules)) {
  console.error('node_modules not found — run `npm install` first.')
  process.exit(1)
}

/** Every .node file in the tree, ignoring Electron's own prebuilt framework. */
function findAddons (dir, out = [], depth = 0) {
  if (depth > 12) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (full.includes(join('node_modules', 'electron', 'dist'))) continue
      findAddons(full, out, depth + 1)
    } else if (e.name.endsWith('.node')) {
      out.push(full)
    }
  }
  return out
}

const archOf = file => {
  try { return execFileSync('file', ['-b', file], { encoding: 'utf8' }).trim() } catch { return '' }
}

/** Which npm package owns this path (handles nesting and scopes). */
function owner (file) {
  const parts = relative(modules, file).split('/')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

// Only Mach-O binaries can load on macOS; everything else is dead weight here.
const addons = findAddons(modules)
const byPkg = new Map()

for (const a of addons) {
  const info = archOf(a)
  if (!info.startsWith('Mach-O')) continue // linux/windows prebuild — inert here
  const pkg = owner(a)
  if (!byPkg.has(pkg)) byPkg.set(pkg, { arm64: [], x64: [] })
  const rec = byPkg.get(pkg)
  // A universal binary contains an arm64 slice, so it counts as arm64.
  if (/arm64/.test(info)) rec.arm64.push(a)
  else if (/x86_64/.test(info)) rec.x64.push(a)
}

console.log(`\nhost architecture : ${process.arch}`)
console.log(`node              : ${process.version}`)
console.log(`packages with macOS native addons: ${byPkg.size}\n`)

const risky = []

for (const [pkg, rec] of [...byPkg].sort()) {
  const ok = rec.arm64.length > 0
  if (!ok) risky.push(pkg)
  console.log(`  ${ok ? '✓' : '✗'} ${pkg.padEnd(22)} arm64:${rec.arm64.length}  x86_64-only:${ok ? 0 : rec.x64.length}`)
}

console.log('')

if (risky.length) {
  console.log('RESULT: these packages only ship x86_64 for macOS and would require')
  console.log('        Rosetta or a local compile:\n')
  for (const p of risky) console.log(`          ${p}`)
  console.log('')
  process.exit(1)
}

console.log('addons: every macOS native addon in the tree provides an arm64 build.\n')
console.log('        Note: these addons are optional accelerators for WebTorrent')
console.log('        (µTP transport, faster WebSocket masking, WebRTC in Node).')
console.log('        The app runs correctly without them — electron-builder is')
console.log('        configured with npmRebuild:false so none are ever compiled.\n')

// ---------------------------------------------------------------------------
// Bundled executables
//
// Addons are not the only way an x86_64 binary gets in. A package can ship a
// plain command-line executable and it will happily run under Rosetta without
// anything failing loudly — ffprobe-static, for one, puts an x86_64 build
// inside its darwin/arm64 directory. Anything we actually spawn gets checked.
// ---------------------------------------------------------------------------

const SPAWNED = [
  ['ffmpeg-static', join(modules, 'ffmpeg-static', 'ffmpeg')]
]

const present = SPAWNED.filter(([, p]) => existsSync(p))

if (present.length) {
  console.log('bundled executables the app spawns:\n')
  const bad = []
  for (const [pkg, p] of present) {
    const info = archOf(p)
    const arm = /arm64/.test(info)
    if (!arm) bad.push([pkg, info])
    console.log(`  ${arm ? '✓' : '✗'} ${pkg.padEnd(22)} ${info.replace('Mach-O 64-bit executable ', '')}`)
  }
  console.log('')
  if (bad.length) {
    console.log('RESULT: a bundled executable is not arm64 and would run under Rosetta:\n')
    for (const [pkg, info] of bad) console.log(`          ${pkg} — ${info}`)
    console.log('')
    process.exit(1)
  }
}

console.log('RESULT: nothing in the tree forces Rosetta.\n')

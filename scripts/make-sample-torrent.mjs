#!/usr/bin/env node
/**
 * Writes a real .torrent file (and its payload) to a directory, for testing
 * the "added from a file" path — the one where a torrent exists in the UI
 * before its infoHash is known.
 *
 * Needs no network: the torrent is created by seeding a local file.
 *
 *   npm run fixture -- /tmp/fixtures
 */
import fs from 'node:fs'
import path from 'node:path'

const outDir = process.argv[2] || path.join(process.cwd(), 'tmp-fixture')
fs.mkdirSync(outDir, { recursive: true })

const { default: WebTorrent } = await import('webtorrent')

// Optional second argument: number of files, for exercising the large-torrent
// path where file lists are only sent for the selected torrent.
const fileCount = Number(process.argv[3] || 1)

let seedTarget
if (fileCount > 1) {
  const dir = path.join(outDir, 'many')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `episode-${String(i + 1).padStart(3, '0')}.mp4`),
      Buffer.alloc(16 * 1024, i % 251))
  }
  seedTarget = dir
} else {
  seedTarget = path.join(outDir, 'payload.bin')
  fs.writeFileSync(seedTarget, Buffer.alloc(256 * 1024, 7))
}

const client = new WebTorrent({ dht: false, tracker: false, lsd: false })
const torrent = await new Promise(resolve =>
  client.seed(seedTarget, { announce: [] }, resolve)
)

const dest = path.join(outDir, 'sample.torrent')
fs.writeFileSync(dest, Buffer.from(torrent.torrentFile))
console.log(`${dest}  (infoHash ${torrent.infoHash})`)

await new Promise(r => client.destroy(r))

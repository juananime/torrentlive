#!/usr/bin/env node
/**
 * Regression test for torrent operations and the streaming server.
 *
 * Covers the bug where every one of remove / pause / resume / reveal /
 * streaming was broken at once because client.get() is async in WebTorrent 3
 * and was being used as if it returned a torrent synchronously.
 *
 * Seeds a real file from disk, so this needs no network and no peers.
 *
 * Run with Electron's Node (24.x) since webtorrent requires node>=22:
 *   npm run test:ops
 */
import { createStreamServer } from '../electron/stream-server.js'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

let pass = 0
let fail = 0

function check (name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`) }
}

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  require('node:http').get(url, { headers }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks)
    }))
  }).on('error', reject)
})

const { default: WebTorrent } = await import('webtorrent')

// A file with recognisable, position-dependent content so range maths is
// actually verified rather than just "some bytes came back".
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtlive-test-'))
const payload = Buffer.from(
  Array.from({ length: 4096 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
)
const filePath = path.join(tmp, 'sample.txt')
fs.writeFileSync(filePath, payload)

const client = new WebTorrent({ dht: false, tracker: false, lsd: false })

const findTorrent = infoHash => {
  const want = String(infoHash).toLowerCase()
  return client.torrents.find(t => t.infoHash === want) || null
}

const stream = createStreamServer({ findTorrent })
const port = await stream.listen()

console.log(`\nnode ${process.version}  ·  stream server on :${port}\n`)

const torrent = await new Promise(resolve =>
  client.seed(filePath, { announce: [] }, resolve)
)
const hash = torrent.infoHash

console.log('the bug that broke everything:')
check('client.get() returns a Promise, not a torrent',
  typeof client.get(hash)?.then === 'function')
check('…so .destroy on its result is undefined',
  typeof client.get(hash).destroy === 'undefined')
check('findTorrent() returns the torrent synchronously',
  findTorrent(hash)?.infoHash === hash)
check('…and it has the methods the IPC handlers call',
  typeof findTorrent(hash).destroy === 'function' &&
  typeof findTorrent(hash).pause === 'function' &&
  Array.isArray(findTorrent(hash).files))

console.log('\nstreaming (this silently 404\'d before the fix):')
const base = `http://127.0.0.1:${port}/stream/${hash}/0`

const full = await get(base)
check('full GET returns 200', full.status === 200, `got ${full.status}`)
check('full GET body matches the file byte-for-byte', full.body.equals(payload))
check('Accept-Ranges advertised', full.headers['accept-ranges'] === 'bytes')
check('not cacheable (partial files must never be cached)',
  full.headers['cache-control'] === 'no-store')

const ranged = await get(base, { Range: 'bytes=100-199' })
check('range GET returns 206', ranged.status === 206, `got ${ranged.status}`)
check('range Content-Range correct',
  ranged.headers['content-range'] === `bytes 100-199/${payload.length}`,
  ranged.headers['content-range'])
check('range body is exactly the requested slice',
  ranged.body.equals(payload.subarray(100, 200)))

const suffix = await get(base, { Range: 'bytes=-50' })
check('suffix range returns the LAST n bytes',
  suffix.status === 206 && suffix.body.equals(payload.subarray(payload.length - 50)))

const open = await get(base, { Range: 'bytes=4000-' })
check('open-ended range runs to end of file',
  open.status === 206 && open.body.equals(payload.subarray(4000)))

const bad = await get(base, { Range: 'bytes=999999-1000000' })
check('unsatisfiable range returns 416', bad.status === 416, `got ${bad.status}`)

const missing = await get(`http://127.0.0.1:${port}/stream/${'0'.repeat(40)}/0`)
check('unknown infohash returns 404', missing.status === 404)

console.log('\npause / resume:')
const t = findTorrent(hash)
t.pause()
check('pause() sets paused', t.paused === true)
t.resume()
check('resume() clears paused', t.paused === false)

console.log('\nremove:')
await new Promise((resolve, reject) =>
  t.destroy({ destroyStore: false }, err => (err ? reject(err) : resolve()))
)
check('destroy() resolves', true)
check('torrent leaves client.torrents', findTorrent(hash) === null)
check('already-destroyed torrent is flagged (guards the hang)', t.destroyed === true)
check('source file kept when destroyStore is false', fs.existsSync(filePath))

await stream.close()
await new Promise(r => client.destroy(r))
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)

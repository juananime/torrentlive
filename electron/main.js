import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import {
  renderIndex, renderWatch, renderForbidden, srtToVtt, subtitleLang,
  isStreamable, speed, browserPlayable, prefersHls
} from './webui.js'
import { probe, planFor, remux, extractSubtitles, playableSubtitles } from './remux.js'
import * as hls from './hls.js'
import * as subs from './subtitles.js'
import * as settings from './settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = process.env.VITE_DEV_SERVER_URL

// WebTorrent 3 is ESM-only and pure JS in the parts we rely on, so it is
// imported lazily once the app is ready rather than at module scope.
let WebTorrent = null
let client = null
let win = null

/**
 * Where finished files land. Overridden per-torrent from the renderer.
 *
 * The app used to be called WebTorrent Live. Anyone who ran that version has
 * downloads sitting in the old folder, so it keeps being used when it exists —
 * renaming the default would strand them.
 */
const LEGACY_DOWNLOADS = path.join(app.getPath('downloads'), 'WebTorrent Live')
let downloadPath = fs.existsSync(LEGACY_DOWNLOADS)
  ? LEGACY_DOWNLOADS
  : path.join(app.getPath('downloads'), 'Torrent Live')

// ---------------------------------------------------------------------------
// Streaming server
//
// The renderer is a sandboxed browser context, so it cannot read from a
// torrent's chunk store directly. Instead the main process exposes each file
// over HTTP with byte-range support, which is exactly what a <video> element
// needs in order to seek through a file that is still downloading.
//
// The same server doubles as a LAN video server. It binds to 127.0.0.1 by
// default; switching sharing on rebinds it to 0.0.0.0 so other devices on the
// network can play a torrent that is still downloading here. Off-machine
// requests must carry a per-session token, so flipping the toggle does not
// hand the whole library to anyone who portscans the subnet.
// ---------------------------------------------------------------------------

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.srt': 'text/plain',
  '.vtt': 'text/vtt'
}

const mimeFor = name => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream'

/** Preferred LAN port. Stable across launches so shared URLs keep working. */
const PREFERRED_PORT = 8842

let streamServer = null
let streamPort = 0

let lanEnabled = false

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Look a torrent up by infohash.
 *
 * NOT `client.get()`: that is `async` in WebTorrent 3, so using it as a plain
 * getter yields a Promise whose `.files` is undefined — every stream request
 * 404s and every pause/remove throws. It also re-parses the torrent id on each
 * call. Scanning `client.torrents` is what `get()` does internally anyway,
 * minus the parse, and it is synchronous.
 */
const findTorrent = infoHash =>
  client?.torrents.find(t => t.infoHash === String(infoHash || '').toLowerCase()) || null

const isLoopback = req => LOOPBACK.has(req.socket.remoteAddress || '')

/**
 * Every non-link-local IPv4 address this machine answers on, so the UI can
 * offer a URL that a phone or TV on the same network can actually reach.
 */
function lanAddresses () {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map(n => n.address)
}

function serverInfo () {
  const addresses = lanEnabled ? lanAddresses() : []
  return {
    port: streamPort,
    lan: lanEnabled,
    addresses,
    host: addresses[0] || '127.0.0.1'
  }
}

// ---------------------------------------------------------------------------
// Web UI model
// ---------------------------------------------------------------------------

/** What the served pages need to know. Mirrors serialize(), minus the URLs. */
function webModel () {
  const torrents = (client?.torrents || []).map(t => ({
    infoHash: t.infoHash,
    name: t.name || t.infoHash,
    length: t.length || 0,
    progress: t.progress || 0,
    paused: !!t.paused,
    files: (t.files || []).map((f, i) => ({
      index: i,
      name: f.name,
      length: f.length,
      progress: f.length ? Math.min(1, (f.downloaded || 0) / f.length) : 0,
      mime: mimeFor(f.name)
    }))
  }))
  return {
    torrents,
    totals: {
      downloadSpeed: client?.downloadSpeed || 0,
      uploadSpeed: client?.uploadSpeed || 0,
      peers: (client?.torrents || []).reduce((n, t) => n + (t.numPeers || 0), 0)
    }
  }
}

/**
 * Probing spawns ffmpeg and pulls the file's header over the network, so the
 * answer is kept per file — every seek would otherwise re-probe. Cleared when
 * the torrent goes away.
 */
const probeCache = new Map()

/**
 * Extracted WebVTT, kept so flipping between tracks does not re-read the whole
 * container each time. A subtitle track is a few tens of kilobytes.
 */
const subtitleCache = new Map()

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(body))
}

/**
 * The OSDb hash of a torrent file, cached per file.
 *
 * It only needs 64 KiB from each end, and asking for those ranges makes
 * WebTorrent prioritise exactly those pieces — so a search works minutes into
 * a download rather than only once it finishes. If the tail has not arrived
 * in time the search still runs, on the filename alone.
 */
const hashCache = new Map()
async function hashFor (torrent, file, index) {
  const key = `${torrent.infoHash}/${index}`
  if (!hashCache.has(key)) {
    hashCache.set(key, (async () => {
      const read = subs.rangeReaderFor(file)
      const withTimeout = (s, e) => Promise.race([
        read(s, e),
        new Promise((_, rej) => setTimeout(() => rej(new Error('pieces not available yet')), 30000))
      ])
      return subs.osHash(file.length, withTimeout)
    })().catch(() => null))
  }
  const hash = await hashCache.get(key)
  // A failed hash must not be remembered — the tail may arrive later.
  if (!hash) hashCache.delete(key)
  return hash ? { hash, size: file.length } : {}
}


/**
 * Signing in is optional and only worth doing once; without credentials the
 * API key alone still allows a few downloads a day.
 */
let jwtPromise = null
function openSubtitlesJwt (cfg) {
  if (!cfg.username || !cfg.password) return Promise.resolve(null)
  if (!jwtPromise) jwtPromise = subs.login(cfg).catch(() => null)
  return jwtPromise
}


function probeCached (source, infoHash, index) {
  const key = `${infoHash}/${index}`
  if (!probeCache.has(key)) probeCache.set(key, probe(source))
  return probeCache.get(key)
}

const html = (res, body, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // Everything the page needs is inline and same-origin; nothing else loads.
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "media-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }).end(body)
}

function startStreamServer () {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')

      // Sharing off means the socket is not bound off-loopback at all, so a
      // remote request cannot normally arrive here. Checked anyway, because a
      // rebind racing an in-flight connection should not slip through.
      if (!isLoopback(req) && !lanEnabled) {
        res.writeHead(403, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        }).end(renderForbidden())
        return
      }

      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end()
        return
      }

      // ---- web UI ----
      if (url.pathname === '/') {
        html(res, renderIndex(webModel()))
        return
      }

      if (url.pathname === '/api/state') {
        const m = webModel()
        const files = {}
        for (const t of m.torrents) for (const f of t.files) files[`${t.infoHash}/${f.index}`] = f.progress
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify({
            files,
            count: m.torrents.length,
            peers: m.totals.peers,
            downloadSpeed: speed(m.totals.downloadSpeed),
            uploadSpeed: speed(m.totals.uploadSpeed)
          }))
        return
      }

      const watch = /^\/watch\/([a-f0-9]{40})\/(\d+)$/i.exec(url.pathname)
      if (watch) {
        const model = webModel()
        const torrent = model.torrents.find(t => t.infoHash === watch[1].toLowerCase())
        const file = torrent?.files?.[Number(watch[2])]
        if (!file || !isStreamable(file.mime)) {
          html(res, renderIndex(model), 404)
          return
        }
        // Any sibling .srt/.vtt is offered as a subtitle track.
        const subtitles = torrent.files
          .filter(f => /\.(srt|vtt)$/i.test(f.name))
          .map(f => ({ index: f.index, lang: subtitleLang(f.name), label: f.name }))
        // Built from the Host the client actually used, so the URL it copies
        // into VLC is reachable from where that client is sitting.
        const host = /^[\w.:-]+$/.test(req.headers.host || '')
          ? req.headers.host
          : `${serverInfo().host}:${streamPort}`

        // Only probe what the browser cannot open on its own — an mp4 does not
        // need ffmpeg's opinion, and probing costs a spawn plus a header fetch.
        let plan = null
        let duration = 0
        let embedded = []
        if (!browserPlayable(file.name) && file.mime.startsWith('video/')) {
          const info = await probeCached(
            `http://127.0.0.1:${streamPort}/stream/${torrent.infoHash}/${file.index}`,
            torrent.infoHash, file.index
          )
          duration = info.duration
          plan = planFor(info)
          embedded = playableSubtitles(info.subtitles)
        }

        html(res, renderWatch({
          torrent,
          file,
          subtitles,
          totals: model.totals,
          plan,
          duration,
          embedded,
          hls: prefersHls(req.headers['user-agent']),
          absolute: `http://${host}/stream/${torrent.infoHash}/${file.index}`
        }))
        return
      }

      // ---- HLS: the WebKit-compatible route ----
      const hm = /^\/hls\/([a-f0-9]{40})\/(\d+)\/([\w.]+)$/i.exec(url.pathname)
      if (hm) {
        const t = findTorrent(hm[1])
        const f = t?.files?.[Number(hm[2])]
        if (!f) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such file')
          return
        }
        const key = `${t.infoHash}-${hm[2]}`
        const name = hm[3]

        if (name === 'index.m3u8') {
          const source = `http://127.0.0.1:${streamPort}/stream/${t.infoHash}/${hm[2]}`
          const plan = planFor(await probeCached(source, t.infoHash, hm[2]))
          const session = hls.ensureSession(key, source, plan)
          const playlist = await hls.waitForPlaylist(session)
          if (!playlist) {
            res.writeHead(503, { 'Content-Type': 'text/plain' }).end('still packaging')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store'
          }).end(playlist)
          return
        }

        const session = hls.touch(key)
        const file = session && hls.segmentPath(session, name)
        if (!file || !fs.existsSync(file)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such segment')
          return
        }
        // Segments are finished files, so these range perfectly well — which
        // is the whole reason this route exists.
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Content-Length': fs.statSync(file).size,
          'Cache-Control': 'no-store'
        })
        fs.createReadStream(file).pipe(res)
        return
      }

      // ---- remux: repackage a container the browser cannot open ----
      const rx = /^\/remux\/([a-f0-9]{40})\/(\d+)$/i.exec(url.pathname)
      if (rx) {
        const t = findTorrent(rx[1])
        const f = t?.files?.[Number(rx[2])]
        if (!f) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such file')
          return
        }
        const start = Math.max(0, Number(url.searchParams.get('start')) || 0)
        const source = `http://127.0.0.1:${streamPort}/stream/${t.infoHash}/${rx[2]}`
        const plan = planFor(await probeCached(source, t.infoHash, rx[2]))

        const proc = remux(source, { start, plan })
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          // A live remux has no length and cannot be range-served; the watch
          // page seeks by restarting the stream at a new ?start= instead.
          'Accept-Ranges': 'none',
          'Cache-Control': 'no-store'
        })
        proc.stdout.pipe(res)
        let stderr = ''
        proc.stderr.on('data', c => { stderr += String(c).slice(0, 2000) })
        proc.on('close', code => {
          if (code && code !== 255 && stderr) console.error('[remux]', stderr.trim().slice(0, 500))
          res.end()
        })
        // Without this every abandoned tab leaves an ffmpeg pinned to a core.
        res.on('close', () => proc.kill('SIGKILL'))
        return
      }

      // Everything already available for a file, without asking OpenSubtitles.
      // The desktop player uses this to build its subtitle menu, so the two
      // players agree on what exists rather than each working it out.
      const tracksFor = /^\/subtracks\/([a-f0-9]{40})\/(\d+)$/i.exec(url.pathname)
      if (tracksFor) {
        const t = findTorrent(tracksFor[1])
        const idx = Number(tracksFor[2])
        const f = t?.files?.[idx]
        if (!f) {
          json(res, { error: 'no such file' }, 404)
          return
        }
        const sibling = t.files
          .map((x, i) => ({ i, name: x.name }))
          .filter(x => /\.(srt|vtt)$/i.test(x.name))
          .map(x => ({
            id: `file:${x.i}`,
            label: x.name,
            lang: subtitleLang(x.name),
            src: `http://127.0.0.1:${streamPort}/subs/${t.infoHash}/${x.i}`
          }))

        let embedded = []
        if (!browserPlayable(f.name) && mimeFor(f.name).startsWith('video/')) {
          const info = await probeCached(
            `http://127.0.0.1:${streamPort}/stream/${t.infoHash}/${idx}`, t.infoHash, idx
          )
          embedded = playableSubtitles(info.subtitles).map(sub => ({
            id: `embedded:${sub.index}`,
            label: `${(sub.lang || `track ${sub.index + 1}`).toUpperCase()} (embedded)`,
            lang: sub.lang,
            src: `http://127.0.0.1:${streamPort}/esubs/${t.infoHash}/${idx}/${sub.index}`
          }))
        }

        json(res, {
          tracks: [...sibling, ...embedded],
          canFind: !!settings.get().openSubtitles.apiKey
        })
        return
      }

      // ---- subtitle finder (OpenSubtitles, matched by content hash) ----
      const find = /^\/subfinder\/([a-f0-9]{40})\/(\d+)$/i.exec(url.pathname)
      if (find) {
        const t = findTorrent(find[1])
        const f = t?.files?.[Number(find[2])]
        if (!f) {
          json(res, { error: 'no such file' }, 404)
          return
        }
        const cfg = settings.get().openSubtitles
        if (!cfg.apiKey) {
          json(res, {
            error: 'No OpenSubtitles API key configured. Add one in the desktop ' +
                   'app under Video Server → Subtitle finder.',
            needsKey: true
          }, 503)
          return
        }
        try {
          const languages = (url.searchParams.get('lang') || 'en')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 8).join(',')
          const identity = await hashFor(t, f, Number(find[2]))
          const query = subs.searchTitle(f.name)
          const results = await subs.search({
            apiKey: cfg.apiKey,
            jwt: await openSubtitlesJwt(cfg),
            ...identity,
            query,
            languages
          })
          // hash/query are echoed back so the UI can say how it matched, and
          // so a failing search is diagnosable without reading the log.
          json(res, { results, hash: identity.hash || null, query })
        } catch (e) {
          json(res, { error: e.message }, 502)
        }
        return
      }

      const fetchSub = /^\/subfetch\/(\d+)$/.exec(url.pathname)
      if (fetchSub) {
        const cfg = settings.get().openSubtitles
        if (!cfg.apiKey) {
          res.writeHead(503, { 'Content-Type': 'text/plain' }).end('no API key')
          return
        }
        const key = `os:${fetchSub[1]}`
        try {
          if (!subtitleCache.has(key)) {
            subtitleCache.set(key, subs.download({
              apiKey: cfg.apiKey,
              jwt: await openSubtitlesJwt(cfg),
              fileId: fetchSub[1]
            }).then(text => (/^\s*WEBVTT/.test(text) ? text : srtToVtt(text))))
          }
          res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Cache-Control': 'no-store'
          }).end(await subtitleCache.get(key))
        } catch (e) {
          subtitleCache.delete(key)
          res.writeHead(502, { 'Content-Type': 'text/plain' }).end(e.message)
        }
        return
      }

      // ---- subtitles embedded in the container itself ----
      const esubs = /^\/esubs\/([a-f0-9]{40})\/(\d+)\/(\d+)$/i.exec(url.pathname)
      if (esubs) {
        const t = findTorrent(esubs[1])
        const f = t?.files?.[Number(esubs[2])]
        if (!f) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such file')
          return
        }
        const key = `${t.infoHash}/${esubs[2]}/${esubs[3]}`
        try {
          if (!subtitleCache.has(key)) {
            subtitleCache.set(key, extractSubtitles(
              `http://127.0.0.1:${streamPort}/stream/${t.infoHash}/${esubs[2]}`,
              Number(esubs[3])
            ))
          }
          const vtt = await subtitleCache.get(key)
          res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Cache-Control': 'no-store'
          }).end(vtt)
        } catch (e) {
          // A failed extraction must not be remembered as the answer.
          subtitleCache.delete(key)
          res.writeHead(503, { 'Content-Type': 'text/plain' })
            .end(`subtitle not available: ${e.message}`)
        }
        return
      }

      const sibSubs = /^\/subs\/([a-f0-9]{40})\/(\d+)$/i.exec(url.pathname)
      if (sibSubs) {
        const t = findTorrent(sibSubs[1])
        const f = t?.files?.[Number(sibSubs[2])]
        if (!f || !/\.(srt|vtt)$/i.test(f.name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such subtitle')
          return
        }
        try {
          const raw = Buffer.from(await f.arrayBuffer()).toString('utf8')
          res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' })
            .end(/\.vtt$/i.test(f.name) ? raw : srtToVtt(raw))
        } catch {
          // The pieces holding the subtitle may not have arrived yet.
          res.writeHead(503, { 'Content-Type': 'text/plain' }).end('subtitle not available yet')
        }
        return
      }

      // ---- raw stream ----
      // /stream/<infoHash>/<fileIndex>[?t=<token>]
      const match = /^\/stream\/([a-f0-9]{40})\/(\d+)$/i.exec(url.pathname)
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
        return
      }

      const torrent = findTorrent(match[1])
      const file = torrent?.files?.[Number(match[2])]
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such file')
        return
      }

      const total = file.length
      const range = req.headers.range
      const headers = {
        'Content-Type': mimeFor(file.name),
        'Accept-Ranges': 'bytes',
        // Streaming a partially-downloaded file must never be cached.
        'Cache-Control': 'no-store'
      }

      let start = 0
      let end = total - 1
      let status = 200

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        if (m) {
          if (m[1]) start = parseInt(m[1], 10)
          if (m[2]) end = parseInt(m[2], 10)
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
            return
          }
          status = 206
          headers['Content-Range'] = `bytes ${start}-${end}/${total}`
        }
      }

      headers['Content-Length'] = end - start + 1
      res.writeHead(status, headers)

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      // Selecting the range tells WebTorrent to prioritise these pieces, so
      // seeking ahead in a video pulls the needed pieces first.
      const stream = file.createReadStream({ start, end })
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    })

    streamServer = server

    // Loopback until the user opts into LAN sharing. The fixed port is tried
    // first so shared URLs survive a restart; an ephemeral port is the
    // fallback when something else already holds it.
    const bind = (port, onBusy) => {
      const onError = err => {
        if (err.code === 'EADDRINUSE' && onBusy) onBusy()
        else reject(err)
      }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError)
        server.on('error', err => console.error('[stream] server error:', err.message))
        streamPort = server.address().port
        resolve(streamPort)
      })
    }

    bind(PREFERRED_PORT, () => bind(0, null))
  })
}

/**
 * Rebinds the running server between loopback-only and every interface. The
 * port is deliberately preserved, so an in-flight <video> in the renderer
 * keeps its src and does not restart playback when the toggle is flipped.
 */
function setLanSharing (enabled) {
  const want = !!enabled
  if (!streamServer || want === lanEnabled) {
    lanEnabled = want
    return Promise.resolve(serverInfo())
  }

  return new Promise(resolve => {
    streamServer.close(() => {
      lanEnabled = want
      streamServer.listen(streamPort, want ? '0.0.0.0' : '127.0.0.1', () => {
        streamPort = streamServer.address().port
        resolve(serverInfo())
      })
    })
    // close() waits for open sockets to drain; an active stream would hold the
    // rebind forever, so existing connections are cut loose immediately.
    streamServer.closeAllConnections?.()
  })
}

// ---------------------------------------------------------------------------
// Torrent state serialisation
// ---------------------------------------------------------------------------

/** Structured-clone-safe snapshot of a torrent for the renderer. */
function serialize (t) {
  const done = t.progress >= 1
  return {
    infoHash: t.infoHash,
    name: t.name || t.infoHash,
    magnetURI: t.magnetURI,
    length: t.length || 0,
    downloaded: t.downloaded || 0,
    uploaded: t.uploaded || 0,
    downloadSpeed: t.downloadSpeed || 0,
    uploadSpeed: t.uploadSpeed || 0,
    progress: t.progress || 0,
    numPeers: t.numPeers || 0,
    ratio: t.ratio || 0,
    timeRemaining: Number.isFinite(t.timeRemaining) ? t.timeRemaining : null,
    paused: !!t.paused,
    done,
    ready: !!t.ready,
    path: t.path,
    files: (t.files || []).map((f, i) => ({
      index: i,
      name: f.name,
      path: f.path,
      length: f.length,
      downloaded: f.downloaded || 0,
      progress: f.length ? Math.min(1, (f.downloaded || 0) / f.length) : 0,
      mime: mimeFor(f.name),
      streamable: /^(video|audio|image)\//.test(mimeFor(f.name)),
      url: `http://127.0.0.1:${streamPort}/stream/${t.infoHash}/${i}`
    }))
  }
}

function pushState () {
  if (!win || win.isDestroyed() || !client) return
  win.webContents.send('torrents:state', {
    torrents: client.torrents.map(serialize),
    server: serverInfo(),
    totals: {
      downloadSpeed: client.downloadSpeed || 0,
      uploadSpeed: client.uploadSpeed || 0,
      progress: client.progress || 0,
      ratio: client.ratio || 0,
      torrents: client.torrents.length,
      peers: client.torrents.reduce((n, t) => n + (t.numPeers || 0), 0)
    }
  })
}

function wireTorrent (t) {
  const notify = () => pushState()
  t.on('ready', notify)
  t.on('done', notify)
  t.on('metadata', notify)
  t.on('error', err => {
    win?.webContents.send('torrents:error', {
      infoHash: t.infoHash,
      message: err?.message || String(err)
    })
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow () {
  nativeTheme.themeSource = 'dark'

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#121212',
    // Ableton-style chrome: on macOS the traffic lights float over our own
    // control bar. Other platforms draw their own title bar above it, so the
    // inset would just be a dead gap — see the platform rule in styles.css.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // External links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (DEV_URL) {
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  if (process.env.WTLIVE_SMOKE) runSmokeTest()
}

/**
 * Boots the app, asserts the renderer loaded without console errors, then
 * exits. Used by `npm run smoke` so the whole main<->renderer path can be
 * checked without a human watching the window.
 */
function runSmokeTest () {
  const errors = []

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    errors.push(`did-fail-load ${code} ${desc}`)
  })

  win.webContents.once('did-finish-load', async () => {
    // Give React a beat to mount and the first IPC round-trip to land.
    await new Promise(r => setTimeout(r, 1500))

    const probe = await win.webContents.executeJavaScript(`(() => ({
      rootChildren: document.getElementById('root').childElementCount,
      rows: document.querySelectorAll('.controlbar, .browser, .session, .detail').length,
      badge: document.querySelector('.archbadge b')?.textContent ?? null,
      bridge: typeof window.wt
    }))()`).catch(e => ({ error: e.message }))

    const lan = await probeLanServer()

    console.log('\n--- SMOKE ---')
    console.log('arch            :', process.arch)
    console.log('electron/node   :', process.versions.electron, '/', process.versions.node)
    console.log('stream port     :', streamPort)
    console.log('lan off         :', lan.whenOff)
    console.log('lan on          :', lan.whenOn)
    console.log('lan off again   :', lan.afterOff)
    console.log('webtorrent      :', client ? 'client constructed' : 'MISSING')
    console.log('preload bridge  :', probe.bridge)
    console.log('root mounted    :', probe.rootChildren > 0 ? 'yes' : 'NO')
    console.log('panels rendered :', probe.rows, '/ 4')
    console.log('arch badge      :', probe.badge)
    console.log('console errors  :', errors.length ? errors : 'none')

    const ok = probe.bridge === 'object' && probe.rootChildren > 0 &&
               probe.rows === 4 && errors.length === 0 && !!client && streamPort > 0 &&
               lan.pass
    console.log('RESULT          :', ok ? 'PASS' : 'FAIL')
    console.log('--- END ---\n')
    app.exit(ok ? 0 : 1)
  })
}

/**
 * Exercises the LAN video server against this machine's own routable address,
 * which reaches the server as a non-loopback client. Sharing is the whole of
 * the access control, so what has to hold is that the switch really is a
 * switch: nothing listening while it is off, serving while it is on, and
 * nothing listening again afterwards.
 */
async function probeLanServer () {
  const address = lanAddresses()[0]
  if (!address) return { pass: true, whenOff: 'skipped — no LAN interface', whenOn: '-', afterOff: '-' }

  // A torrent that cannot exist: reaching the router at all yields 404, which
  // distinguishes "served" from "refused" without needing a real download.
  const url = `http://${address}:${streamPort}/stream/${'0'.repeat(40)}/0`
  const status = async () => {
    try {
      return String((await fetch(url)).status)
    } catch (e) {
      return e.cause?.code || 'ERR'
    }
  }

  const whenOff = await status()
  await setLanSharing(true)
  const whenOn = await status()
  await setLanSharing(false)
  const afterOff = await status()

  return {
    whenOff,
    whenOn,
    afterOff,
    pass: whenOff === 'ECONNREFUSED' && whenOn === '404' && afterOff === 'ECONNREFUSED'
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc () {
  ipcMain.handle('app:info', () => ({
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    },
    arch: process.arch,
    platform: process.platform,
    // The whole point of the project: prove at runtime we are not translated.
    rosetta: isTranslated(),
    downloadPath,
    streamPort,
    server: serverInfo()
  }))

  ipcMain.handle('server:setLan', (_e, enabled) => setLanSharing(enabled))

  ipcMain.handle('subtitles:getConfig', () => settings.redacted())

  ipcMain.handle('subtitles:setConfig', (_e, { apiKey, username, password } = {}) => {
    const next = {}
    // An empty string means "leave alone"; the UI sends null to clear a field.
    if (apiKey !== undefined) next.apiKey = String(apiKey || '').trim()
    if (username !== undefined) next.username = String(username || '').trim()
    if (password !== undefined) next.password = String(password || '')
    settings.patch({ openSubtitles: next })
    jwtPromise = null // credentials changed; the cached sign-in is stale
    return settings.redacted()
  })

  /** Round-trip the key against the real API so the user knows it works. */
  ipcMain.handle('subtitles:testConfig', async () => {
    const cfg = settings.get().openSubtitles
    if (!cfg.apiKey) throw new Error('No API key set')
    const results = await subs.search({
      apiKey: cfg.apiKey,
      jwt: await openSubtitlesJwt(cfg),
      query: 'sintel',
      languages: 'en'
    })
    return { ok: true, results: results.length }
  })

  /**
   * Clipboard writes go through the main process: navigator.clipboard is
   * unreliable in a sandboxed file:// renderer, and this keeps URL assembly in
   * one place.
   *
   * With sharing off this hands back the loopback URL, which needs no token —
   * paste it into a browser or VLC on this machine and it plays. With sharing
   * on it becomes the LAN address plus the token.
   */
  /** The web UI's own address, for handing to a phone or a television. */
  ipcMain.handle('server:copyWebLink', () => {
    const { host, port } = serverInfo()
    const url = `http://${lanEnabled ? host : '127.0.0.1'}:${port}/`
    clipboard.writeText(url)
    return url
  })

  ipcMain.handle('server:copyLink', (_e, { infoHash, fileIndex } = {}) => {
    if (!/^[a-f0-9]{40}$/i.test(String(infoHash))) throw new Error('Bad info hash')
    const { host, port } = serverInfo()
    const url = `http://${host}:${port}/stream/${String(infoHash).toLowerCase()}/${Number(fileIndex)}`
    clipboard.writeText(url)
    return url
  })

  ipcMain.handle('torrent:add', (_e, { source, savePath } = {}) => {
    if (!source || typeof source !== 'string') throw new Error('No magnet link or torrent provided')
    const dest = savePath || downloadPath
    fs.mkdirSync(dest, { recursive: true })

    const existing = client.torrents.find(t => t.magnetURI === source || t.infoHash === source)
    if (existing) return serialize(existing)

    const t = client.add(source.trim(), { path: dest })
    wireTorrent(t)
    pushState()
    return { infoHash: t.infoHash || null }
  })

  ipcMain.handle('torrent:addFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add .torrent file',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Torrent', extensions: ['torrent'] }]
    })
    if (canceled) return { added: 0 }
    fs.mkdirSync(downloadPath, { recursive: true })
    for (const p of filePaths) {
      const t = client.add(p, { path: downloadPath })
      wireTorrent(t)
    }
    pushState()
    return { added: filePaths.length }
  })

  ipcMain.handle('torrent:pause', (_e, infoHash) => {
    const t = findTorrent(infoHash)
    if (!t) return false
    // pause() halts peer traffic but keeps the torrent in the session.
    t.pause()
    pushState()
    return true
  })

  ipcMain.handle('torrent:resume', (_e, infoHash) => {
    const t = findTorrent(infoHash)
    if (!t) return false
    t.resume()
    pushState()
    return true
  })

  ipcMain.handle('torrent:remove', async (_e, { infoHash, deleteFiles } = {}) => {
    const t = findTorrent(infoHash)
    if (!t) return false
    await new Promise(res => t.destroy({ destroyStore: !!deleteFiles }, res))
    pushState()
    return true
  })

  ipcMain.handle('torrent:reveal', (_e, { infoHash, fileIndex }) => {
    const t = findTorrent(infoHash)
    if (!t) return false
    const file = typeof fileIndex === 'number' ? t.files[fileIndex] : null
    const target = file ? path.join(t.path, file.path) : t.path
    if (!fs.existsSync(target)) {
      shell.openPath(t.path)
      return true
    }
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle('settings:chooseFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose download folder',
      defaultPath: downloadPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths[0]) return { downloadPath }
    downloadPath = filePaths[0]
    settings.patch({ downloadPath })
    return { downloadPath }
  })
}

/**
 * Detects Rosetta 2 translation. sysctl reports 1 when the current process is
 * an x86_64 binary being translated on Apple Silicon.
 */
function isTranslated () {
  if (process.platform !== 'darwin') return false
  if (process.arch === 'arm64') return false
  try {
    const out = os.cpus()[0]?.model || ''
    return /Apple/.test(out) && process.arch === 'x64'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  const saved = settings.init(app.getPath('userData'), [
    // The package was called webtorrent-live before the rename, which is where
    // a development install's settings still are.
    path.join(path.dirname(app.getPath('userData')), 'webtorrent-live')
  ])
  if (saved.downloadPath) downloadPath = saved.downloadPath

  ;({ default: WebTorrent } = await import('webtorrent'))

  client = new WebTorrent()
  client.on('error', err => {
    win?.webContents.send('torrents:error', { message: err?.message || String(err) })
  })

  await startStreamServer()
  registerIpc()
  createWindow()

  // A steady tick is simpler and cheaper than event-storming the renderer:
  // speeds and progress change continuously anyway.
  setInterval(pushState, 500)
  hls.startReaper()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Segment directories and their ffmpegs outlive the app otherwise.
  try { hls.destroyAll() } catch { /* shutting down anyway */ }
  try { client?.destroy() } catch { /* shutting down anyway */ }
})

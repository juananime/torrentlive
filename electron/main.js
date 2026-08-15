import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = process.env.VITE_DEV_SERVER_URL

// WebTorrent 3 is ESM-only and pure JS in the parts we rely on, so it is
// imported lazily once the app is ready rather than at module scope.
let WebTorrent = null
let client = null
let win = null

/** Where finished files land. Overridden per-torrent from the renderer. */
let downloadPath = path.join(app.getPath('downloads'), 'WebTorrent Live')

// ---------------------------------------------------------------------------
// Streaming server
//
// The renderer is a sandboxed browser context, so it cannot read from a
// torrent's chunk store directly. Instead the main process exposes each file
// over loopback HTTP with byte-range support, which is exactly what a <video>
// element needs in order to seek through a file that is still downloading.
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

let streamPort = 0

function startStreamServer () {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // /stream/<infoHash>/<fileIndex>
      const match = /^\/stream\/([a-f0-9]{40})\/(\d+)/i.exec(req.url || '')
      if (!match) {
        res.writeHead(404).end('not found')
        return
      }

      const torrent = client?.get(match[1].toLowerCase())
      const file = torrent?.files?.[Number(match[2])]
      if (!file) {
        res.writeHead(404).end('no such file')
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

    server.on('error', reject)
    // Loopback only — never expose torrent contents to the network.
    server.listen(0, '127.0.0.1', () => {
      streamPort = server.address().port
      resolve(streamPort)
    })
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
    // Ableton-style chrome: the traffic lights float over our own control bar.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
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

    console.log('\n--- SMOKE ---')
    console.log('arch            :', process.arch)
    console.log('electron/node   :', process.versions.electron, '/', process.versions.node)
    console.log('stream port     :', streamPort)
    console.log('webtorrent      :', client ? 'client constructed' : 'MISSING')
    console.log('preload bridge  :', probe.bridge)
    console.log('root mounted    :', probe.rootChildren > 0 ? 'yes' : 'NO')
    console.log('panels rendered :', probe.rows, '/ 4')
    console.log('arch badge      :', probe.badge)
    console.log('console errors  :', errors.length ? errors : 'none')

    const ok = probe.bridge === 'object' && probe.rootChildren > 0 &&
               probe.rows === 4 && errors.length === 0 && !!client && streamPort > 0
    console.log('RESULT          :', ok ? 'PASS' : 'FAIL')
    console.log('--- END ---\n')
    app.exit(ok ? 0 : 1)
  })
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
    // The whole point of the project: prove at runtime we are not translated.
    rosetta: isTranslated(),
    downloadPath,
    streamPort
  }))

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
    const t = client.get(infoHash)
    if (!t) return false
    // pause() halts peer traffic but keeps the torrent in the session.
    t.pause()
    pushState()
    return true
  })

  ipcMain.handle('torrent:resume', (_e, infoHash) => {
    const t = client.get(infoHash)
    if (!t) return false
    t.resume()
    pushState()
    return true
  })

  ipcMain.handle('torrent:remove', async (_e, { infoHash, deleteFiles } = {}) => {
    const t = client.get(infoHash)
    if (!t) return false
    await new Promise(res => t.destroy({ destroyStore: !!deleteFiles }, res))
    pushState()
    return true
  })

  ipcMain.handle('torrent:reveal', (_e, { infoHash, fileIndex }) => {
    const t = client.get(infoHash)
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  try { client?.destroy() } catch { /* shutting down anyway */ }
})

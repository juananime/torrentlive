import http from 'node:http'
import path from 'node:path'

/**
 * Serves torrent files over loopback HTTP with byte-range support.
 *
 * The renderer is sandboxed and cannot read a torrent's chunk store, so a
 * <video> element points here instead. Range support is the whole point:
 * requesting a range makes WebTorrent prioritise those pieces, which is what
 * lets playback start and seek before the download has finished.
 */

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

export const mimeFor = name =>
  MIME[path.extname(name).toLowerCase()] || 'application/octet-stream'

/**
 * @param {object} opts
 * @param {(infoHash: string) => object|null} opts.findTorrent  synchronous lookup
 * @param {(name: string) => string=} opts.artworkFor  optional demo placeholder
 */
export function createStreamServer ({ findTorrent, artworkFor = null }) {
  const server = http.createServer((req, res) => {
    const match = /^\/stream\/([a-f0-9]{40})\/(\d+)/i.exec(req.url || '')
    if (!match) {
      res.writeHead(404).end('not found')
      return
    }

    const torrent = findTorrent(match[1])
    const file = torrent?.files?.[Number(match[2])]

    // Demo mode has no real chunk store; hand back placeholder artwork so the
    // preview pane still shows something.
    if (!file) {
      if (artworkFor) {
        const svg = artworkFor(match[1])
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Content-Length': Buffer.byteLength(svg),
          'Cache-Control': 'no-store'
        })
        res.end(svg)
        return
      }
      res.writeHead(404).end('no such file')
      return
    }

    const total = file.length
    const headers = {
      'Content-Type': mimeFor(file.name),
      'Accept-Ranges': 'bytes',
      // A partially-downloaded file must never be cached.
      'Cache-Control': 'no-store'
    }

    let start = 0
    let end = total - 1
    let status = 200

    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        // "bytes=-500" means the *last* 500 bytes, not bytes 0..500.
        if (m[1] === '' && m[2] !== '') {
          start = Math.max(0, total - parseInt(m[2], 10))
        } else {
          if (m[1]) start = parseInt(m[1], 10)
          if (m[2]) end = parseInt(m[2], 10)
        }
        if (end > total - 1) end = total - 1
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

    const stream = file.createReadStream({ start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  })

  return {
    server,
    /** Binds to loopback only — torrent contents never reach the network. */
    listen () {
      return new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      })
    },
    close () {
      return new Promise(resolve => server.close(resolve))
    }
  }
}

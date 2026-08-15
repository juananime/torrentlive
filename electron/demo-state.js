/**
 * Sample data for UI work — enabled only with WTLIVE_DEMO=1.
 *
 * Designing the session view against an empty client is hopeless: row
 * striping, clip colours, meter states and column alignment are invisible
 * until something is in the list. This module fabricates a believable session
 * so the layout can be reviewed and screenshotted without a live swarm.
 *
 * main.js swaps this in for the entire state payload rather than injecting
 * into the real client, so fabricated numbers can never mix into a real
 * session.
 */

const MB = 1024 * 1024
const GB = 1024 * MB

// Creative Commons / freely distributable titles.
const SEED = [
  {
    name: 'Big Buck Bunny (2008) [1080p][BluRay][x264]',
    length: 4.7 * GB,
    progress: 0.412,
    downloadSpeed: 6.2 * MB,
    uploadSpeed: 480 * 1024,
    numPeers: 34,
    files: [
      ['Big.Buck.Bunny.1080p.mkv', 4.42 * GB, 'video/x-matroska'],
      ['Big.Buck.Bunny.1080p.en.srt', 84 * 1024, 'text/plain'],
      ['poster.jpg', 1.9 * MB, 'image/jpeg'],
      ['RELEASE.nfo', 4 * 1024, 'text/plain']
    ]
  },
  {
    name: 'Sintel — Blender Open Movie Project',
    length: 1.1 * GB,
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 1.4 * MB,
    numPeers: 12,
    files: [
      ['Sintel.2010.1080p.mp4', 1.03 * GB, 'video/mp4'],
      ['Sintel.trailer.mp4', 62 * MB, 'video/mp4'],
      ['cover.png', 2.4 * MB, 'image/png']
    ]
  },
  {
    name: 'Tears of Steel [4K][HDR]',
    length: 8.9 * GB,
    progress: 0.073,
    downloadSpeed: 11.8 * MB,
    uploadSpeed: 96 * 1024,
    numPeers: 61,
    files: [
      ['Tears.of.Steel.2160p.mkv', 8.7 * GB, 'video/x-matroska'],
      ['behind-the-scenes.mkv', 190 * MB, 'video/x-matroska']
    ]
  },
  {
    name: 'Kevin MacLeod — Royalty Free Music Collection (FLAC)',
    length: 3.2 * GB,
    progress: 0.884,
    downloadSpeed: 2.1 * MB,
    uploadSpeed: 220 * 1024,
    numPeers: 9,
    files: [
      ['01 - Impact Moderato.flac', 38 * MB, 'audio/flac'],
      ['02 - Carefree.flac', 41 * MB, 'audio/flac'],
      ['03 - Wallpaper.flac', 33 * MB, 'audio/flac'],
      ['04 - Cipher.flac', 46 * MB, 'audio/flac'],
      ['folder.jpg', 900 * 1024, 'image/jpeg']
    ]
  },
  {
    name: 'archlinux-2026.08.01-x86_64.iso',
    length: 1.3 * GB,
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    numPeers: 0,
    paused: true,
    files: [['archlinux-2026.08.01-x86_64.iso', 1.3 * GB, 'application/octet-stream']]
  },
  {
    name: 'NASA Apollo 11 Restored Footage [ProRes]',
    length: 22 * GB,
    progress: 0.219,
    downloadSpeed: 4.4 * MB,
    uploadSpeed: 12 * 1024,
    numPeers: 18,
    files: [
      ['Apollo11_Restored_Reel1.mov', 11 * GB, 'video/quicktime'],
      ['Apollo11_Restored_Reel2.mov', 10.6 * GB, 'video/quicktime'],
      ['transcript.txt', 220 * 1024, 'text/plain']
    ]
  }
]

/** Deterministic 40-hex infohash so clip colours stay stable between runs. */
function fakeHash (i, name) {
  let h = 0x811c9dc5
  for (const ch of `${i}:${name}`) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  let out = ''
  let x = h
  while (out.length < 40) {
    x = Math.imul(x ^ (x >>> 15), 0x2545f491) >>> 0
    out += x.toString(16).padStart(8, '0')
  }
  return out.slice(0, 40)
}

const NAMES = new Map()
const started = Date.now()

export function demoState (streamPort) {
  // Drift progress slowly so meters visibly move while the UI is open.
  const t = (Date.now() - started) / 1000

  const torrents = SEED.map((s, i) => {
    const infoHash = fakeHash(i, s.name)
    NAMES.set(infoHash, s.name)

    const paused = !!s.paused
    const finished = s.progress >= 1
    const progress = finished || paused
      ? s.progress
      : Math.min(0.999, s.progress + t * 0.0009 * (1 + i * 0.3))

    const downloaded = Math.round(s.length * progress)
    const dl = paused || finished ? 0 : s.downloadSpeed * (0.85 + 0.3 * Math.sin(t / 3 + i))
    const ul = paused ? 0 : s.uploadSpeed * (0.8 + 0.4 * Math.cos(t / 4 + i))

    const files = s.files.map(([name, length, mime], index) => {
      // Fill files in order, mirroring how a sequential download looks.
      const before = s.files.slice(0, index).reduce((n, f) => n + f[1], 0)
      const take = Math.max(0, Math.min(length, downloaded - before))
      return {
        index,
        name,
        path: `${s.name}/${name}`,
        length,
        downloaded: take,
        progress: length ? Math.min(1, take / length) : 0,
        mime,
        streamable: /^(video|audio|image)\//.test(mime),
        url: `http://127.0.0.1:${streamPort}/stream/${infoHash}/${index}`
      }
    })

    return {
      id: infoHash,
      infoHash,
      name: s.name,
      magnetURI: `magnet:?xt=urn:btih:${infoHash}`,
      length: s.length,
      downloaded,
      uploaded: Math.round(s.length * 0.31),
      downloadSpeed: Math.max(0, dl),
      uploadSpeed: Math.max(0, ul),
      progress,
      numPeers: s.numPeers,
      ratio: finished ? 1.8 + i * 0.4 : 0.2 + i * 0.1,
      timeRemaining: dl > 0 ? ((s.length - downloaded) / dl) * 1000 : null,
      paused,
      done: progress >= 1,
      ready: true,
      path: `/Users/you/Downloads/Torrent Live/${s.name}`,
      files
    }
  })

  return {
    torrents,
    totals: {
      downloadSpeed: torrents.reduce((n, x) => n + x.downloadSpeed, 0),
      uploadSpeed: torrents.reduce((n, x) => n + x.uploadSpeed, 0),
      progress: 0.44,
      ratio: 1.27,
      torrents: torrents.length,
      peers: torrents.reduce((n, x) => n + x.numPeers, 0)
    }
  }
}

/**
 * Placeholder artwork for the preview pane in demo mode, where there is no
 * real chunk store to stream from. SVG keeps this to a few lines of text
 * rather than hand-rolling a PNG encoder.
 */
export function demoArtwork (infoHash) {
  const label = (NAMES.get(String(infoHash).toLowerCase()) || 'Preview')
    .replace(/[<&>]/g, '')
    .slice(0, 54)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
  <rect width="640" height="360" fill="#0d0d0d"/>
  <circle cx="320" cy="158" r="44" fill="none" stroke="#ffe900" stroke-width="2"/>
  <path d="M307 135 L350 158 L307 181 Z" fill="#ffe900"/>
  <text x="320" y="238" fill="#c8c8c8" font-family="Helvetica,Arial" font-size="13"
        text-anchor="middle">${label}</text>
  <text x="320" y="259" fill="#5a5a5a" font-family="Helvetica,Arial" font-size="10"
        text-anchor="middle" letter-spacing="1">DEMO MODE — NO DATA IS BEING TRANSFERRED</text>
</svg>`
}

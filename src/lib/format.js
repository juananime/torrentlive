const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function bytes (n) {
  if (!n || n < 0) return '0 B'
  let i = 0
  let v = n
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`
}

export function speed (n) {
  if (!n || n < 1) return '—'
  return `${bytes(n)}/s`
}

export function pct (p) {
  return `${((p || 0) * 100).toFixed(p >= 1 ? 0 : 1)}%`
}

/** WebTorrent reports timeRemaining in ms; Infinity when it cannot estimate. */
export function eta (ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * Stable per-torrent "clip colour", picked from Live's pastel palette by
 * hashing the infoHash so a torrent keeps its colour across restarts.
 */
const CLIPS = [
  'var(--clip-1)', 'var(--clip-2)', 'var(--clip-3)', 'var(--clip-4)',
  'var(--clip-5)', 'var(--clip-6)', 'var(--clip-7)', 'var(--clip-8)'
]

export function clipColor (infoHash) {
  // Coerced rather than defaulted: a torrent has no infoHash until its
  // metadata is parsed, and serialize() sends null for that state. A default
  // parameter only covers undefined, so null would still throw here.
  const s = infoHash == null ? '' : String(infoHash)
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return CLIPS[h % CLIPS.length]
}

export function kindOf (mime) {
  mime = mime == null ? '' : String(mime)
  if (mime.startsWith('video/')) return 'vid'
  if (mime.startsWith('audio/')) return 'aud'
  if (mime.startsWith('image/')) return 'img'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'txt'
  return 'bin'
}

/** Accepts a magnet URI or a bare 40-char infohash. */
export function looksLikeTorrentSource (s) {
  const v = (s == null ? '' : String(s)).trim()
  return /^magnet:\?/i.test(v) || /^[a-f0-9]{40}$/i.test(v) || /^https?:\/\/.+\.torrent/i.test(v)
}

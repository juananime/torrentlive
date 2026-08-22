// ---------------------------------------------------------------------------
// Subtitle finder.
//
// The same approach VLC's VLSub takes: identify the video by a hash of its
// bytes rather than by its name, and ask OpenSubtitles what matches. Matching
// on the hash is the whole point — it returns subtitles timed against this
// exact release, so they are in sync without nudging the offset. Filename
// search is only the fallback for when the hash is unknown to the database.
// ---------------------------------------------------------------------------

const API = 'https://api.opensubtitles.com/api/v1'

/** OpenSubtitles requires a registered, identifying User-Agent on every call. */
const UA = 'TorrentLive v0.1.0'

/** The hash reads this much from each end of the file. Fixed by the spec. */
export const HASH_CHUNK = 65536

const MASK64 = (1n << 64n) - 1n

/**
 * The OpenSubtitles ("OSDb") hash: the file size, plus every little-endian
 * 64-bit word in the first and last 64 KiB, summed with wraparound.
 *
 * Deliberately cheap — it never reads the middle of the file, which is what
 * makes it usable on a torrent that is still downloading. Files smaller than
 * 128 KiB have no meaningful hash and are rejected rather than fudged.
 *
 * `readRange(start, end)` is inclusive of both ends, matching HTTP ranges and
 * WebTorrent's createReadStream.
 */
export async function osHash (size, readRange) {
  if (!Number.isFinite(size) || size < HASH_CHUNK * 2) {
    throw new Error('file is too small to hash')
  }

  let sum = BigInt(size) & MASK64

  const addChunk = buf => {
    for (let i = 0; i + 8 <= buf.length; i += 8) {
      sum = (sum + buf.readBigUInt64LE(i)) & MASK64
    }
  }

  addChunk(await readRange(0, HASH_CHUNK - 1))
  addChunk(await readRange(size - HASH_CHUNK, size - 1))

  return sum.toString(16).padStart(16, '0')
}

/** Collects a WebTorrent file's byte range into one Buffer. */
export function rangeReaderFor (file) {
  return (start, end) => new Promise((resolve, reject) => {
    const chunks = []
    const stream = file.createReadStream({ start, end })
    stream.on('data', c => chunks.push(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** Scene furniture that only confuses a title search. */
const NOISE = new RegExp([
  // Audio codecs, with the channel layout that trails them. Dots have already
  // become spaces by this point, so "AAC2.0" arrives as "AAC2 0" — and the
  // layout cannot be matched on its own, because "1999 1080p" looks identical.
  String.raw`\b(?:aac|ac-?3|e-?ac-?3|dts(?:-hd)?|truehd|atmos|ddp?|dd|opus|flac)\d*(?:\s\d\b)?`,
  // Everything else is a plain token.
  String.raw`\b(?:\d{3,4}p|4k|uhd|blu-?ray|brrip|bdrip|web-?rip|web-?dl|hdtv|dvdrip|xvid|x26[45]|h\.?26[45]|hevc|avc|\d{1,2}bit|hdr\d*|remux|proper|repack|extended|unrated|internal|limited|multi|dual)\b`
].join('|'), 'gi')

/**
 * Release names carry a lot of noise a title search chokes on. Strip the
 * usual scene furniture so the fallback query has a chance of matching.
 */
export function searchTitle (name) {
  // Applied twice: removing one token often exposes another that was not on a
  // word boundary before (…x265.10bit… leaves a bare "10bit" only once "x265"
  // has gone).
  let s = String(name)
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[._]+/g, ' ')
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(NOISE, ' ')
      .replace(/\s{2,}/g, ' ')
  }
  return s
    .replace(/[-–—]\s*[a-z0-9]+\s*$/i, '')            // trailing release group
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function headers (apiKey, jwt) {
  const h = {
    'Api-Key': apiKey,
    'User-Agent': UA,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  if (jwt) h.Authorization = `Bearer ${jwt}`
  return h
}

/**
 * Optional. An API key alone allows a handful of downloads a day; signing in
 * raises that considerably, so credentials are supported but never required.
 */
export async function login ({ apiKey, username, password }) {
  const res = await fetch(`${API}/login`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ username, password })
  })
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`)
  const body = await res.json()
  return body.token
}

/**
 * Search by hash first, then by name. Both queries go out together because
 * the hash frequently misses on lesser-known releases, and a filename result
 * the viewer can nudge beats no result at all — but hash matches always sort
 * first, since only they are guaranteed to be in sync.
 */
export async function search ({ apiKey, jwt, hash, size, query, languages = 'en' }) {
  if (!apiKey) throw new Error('no OpenSubtitles API key configured')

  const call = async params => {
    const url = `${API}/subtitles?${new URLSearchParams(params)}`
    const res = await fetch(url, { headers: headers(apiKey, jwt) })
    if (res.status === 401 || res.status === 403) {
      throw new Error('OpenSubtitles rejected the API key')
    }
    if (res.status === 429) throw new Error('OpenSubtitles rate limit reached — try again shortly')
    if (!res.ok) throw new Error(`OpenSubtitles returned ${res.status}`)
    return (await res.json()).data || []
  }

  // Either query may legitimately come back empty, so a failure in one is not
  // fatal — but if both fail the reason has to reach the user, or a rejected
  // API key is indistinguishable from a film nobody has subtitled.
  const errors = []
  const attempt = params => call(params).catch(e => { errors.push(e); return null })

  const [byHash, byName] = await Promise.all([
    hash ? attempt({ moviehash: hash, languages }) : null,
    query ? attempt({ query, languages }) : null
  ])

  if (byHash === null && byName === null && errors.length) throw errors[0]

  return rank(byHash || [], byName || [], query)
}

/** Words worth comparing on — short ones and articles match everything. */
const tokens = s => new Set(
  String(s).toLowerCase().match(/[a-z0-9]{4,}/g)?.filter(w => !STOP.has(w)) || []
)
const STOP = new Set(['the', 'and', 'part', 'movie', 'film', 'subs', 'subtitle', 'english'])

/**
 * Does this subtitle's name look like it belongs to the film we asked about?
 *
 * OpenSubtitles' hash index has bad entries — a Star Wars subtitle is
 * registered against Sintel's hash and comes back flagged as an exact match,
 * with 300k downloads behind it. Trusting `moviehash_match` alone therefore
 * puts obvious junk at the top, so a title agreement is used to break the tie.
 */
export function titleAffinity (name, release, query) {
  const want = tokens(query)
  if (!want.size) return 0
  const have = tokens(`${name} ${release}`)
  for (const w of want) if (have.has(w)) return 1
  return 0
}

/**
 * Hash matches first, then subtitles whose name agrees with the title, then
 * by download count — a decent proxy for "this is the one that actually fits".
 */
export function rank (byHash, byName, query = '') {
  const seen = new Set()
  const out = []

  for (const list of [byHash, byName]) {
    for (const item of list) {
      const a = item?.attributes
      const f = a?.files?.[0]
      if (!f?.file_id || seen.has(f.file_id)) continue
      seen.add(f.file_id)
      out.push({
        fileId: f.file_id,
        name: f.file_name || a.release || 'subtitle',
        release: a.release || '',
        lang: (a.language || '').toLowerCase(),
        downloads: a.download_count || 0,
        hearingImpaired: !!a.hearing_impaired,
        fps: a.fps || null,
        // A moviehash query still returns near-misses when the hash is
        // unknown, so being in that response proves nothing — only the
        // server's own flag does. Anything less and an unrelated blockbuster
        // with 300k downloads outranks the real match.
        exact: a.moviehash_match === true,
        titled: titleAffinity(f.file_name || '', a.release || '', query)
      })
    }
  }

  return out.sort((a, b) =>
    (b.exact - a.exact) ||
    (b.titled - a.titled) ||
    (b.downloads - a.downloads)
  )
}

/**
 * Two steps by design on OpenSubtitles' side: ask for a link, then fetch it.
 * The link is single-use and expires, so it is never cached.
 */
export async function download ({ apiKey, jwt, fileId }) {
  const res = await fetch(`${API}/download`, {
    method: 'POST',
    headers: headers(apiKey, jwt),
    body: JSON.stringify({ file_id: Number(fileId) })
  })
  if (res.status === 406) throw new Error('download quota exhausted for today')
  if (!res.ok) throw new Error(`OpenSubtitles returned ${res.status}`)

  const { link } = await res.json()
  if (!link) throw new Error('OpenSubtitles returned no download link')

  const sub = await fetch(link, { headers: { 'User-Agent': UA } })
  if (!sub.ok) throw new Error(`subtitle fetch failed (${sub.status})`)
  return await sub.text()
}

// ---------------------------------------------------------------------------
// HLS output.
//
// The progressive fragmented-MP4 remux plays in Chrome but not in Safari:
// WebKit requires a media source to support byte ranges, and a stream being
// generated live cannot. That rules out every WebKit browser — iPhones, iPads,
// and most smart-TV browsers, which is precisely the audience for a LAN video
// server.
//
// HLS solves it the way Safari expects: a playlist of finished segments, each
// an ordinary file that ranges perfectly well. Safari plays it natively from a
// plain <video src="…m3u8">, no JavaScript player needed.
//
// A session is one ffmpeg writing segments into a temp directory. Sessions are
// keyed by file, reused across requests, and reaped once nobody has asked for
// a segment in a while.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FFMPEG } from './remux.js'

/** Segment length. Four seconds is the usual balance of startup vs overhead. */
const SEGMENT_SECONDS = 4

/** A session with no requests for this long is shut down and deleted. */
const IDLE_MS = 90_000

const sessions = new Map()

function sessionDir (key) {
  return path.join(os.tmpdir(), `wtlive-hls-${key.replace(/[^a-z0-9]/gi, '-')}`)
}

/**
 * Start (or reuse) the ffmpeg writing HLS for this file.
 *
 * `hls_playlist_type event` keeps every segment in the playlist as it grows,
 * so the viewer can seek back over anything already produced — and because the
 * video is usually stream-copied, ffmpeg runs far ahead of playback.
 */
export function ensureSession (key, sourceUrl, plan) {
  const existing = sessions.get(key)
  if (existing) {
    existing.touched = Date.now()
    return existing
  }

  const dir = sessionDir(key)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', sourceUrl,
    '-c:v', plan.videoCopy ? 'copy' : 'libx264'
  ]
  if (!plan.videoCopy) args.push('-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p')

  args.push('-c:a', plan.audioCopy ? 'copy' : 'aac')
  if (!plan.audioCopy) args.push('-ac', '2', '-b:a', '160k')

  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8')
  )

  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', c => { stderr += String(c).slice(0, 4000) })
  proc.on('close', code => {
    const s = sessions.get(key)
    if (s) s.finished = true
    if (code && code !== 255 && stderr) console.error('[hls]', stderr.trim().slice(0, 400))
  })

  const session = { key, dir, proc, touched: Date.now(), finished: false }
  sessions.set(key, session)
  return session
}

/**
 * Waits for the playlist to name at least one segment. Safari aborts if it is
 * handed a playlist it cannot start from, so the first request blocks briefly
 * rather than returning an empty one.
 */
export async function waitForPlaylist (session, timeoutMs = 25_000) {
  const file = path.join(session.dir, 'index.m3u8')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (/^seg\d+\.ts$/m.test(text)) return text
    } catch { /* ffmpeg has not written it yet */ }
    if (session.finished && fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    await new Promise(r => setTimeout(r, 250))
  }
  return null
}

export function readPlaylist (session) {
  try { return fs.readFileSync(path.join(session.dir, 'index.m3u8'), 'utf8') } catch { return null }
}

/** Resolves a segment name against the session directory, refusing traversal. */
export function segmentPath (session, name) {
  if (!/^seg\d+\.ts$/.test(name)) return null
  return path.join(session.dir, name)
}

export function touch (key) {
  const s = sessions.get(key)
  if (s) s.touched = Date.now()
  return s
}

export function get (key) {
  return sessions.get(key)
}

function destroy (session) {
  try { session.proc.kill('SIGKILL') } catch { /* already gone */ }
  fs.rmSync(session.dir, { recursive: true, force: true })
  sessions.delete(session.key)
}

/** Reap idle sessions — each one costs an ffmpeg and a directory of segments. */
export function startReaper () {
  const timer = setInterval(() => {
    const now = Date.now()
    for (const s of [...sessions.values()]) {
      if (now - s.touched > IDLE_MS) destroy(s)
    }
  }, 15_000)
  timer.unref?.()
  return timer
}

export function destroyAll () {
  for (const s of [...sessions.values()]) destroy(s)
}

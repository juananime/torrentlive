// ---------------------------------------------------------------------------
// On-the-fly remuxing.
//
// Browsers ship no Matroska demuxer, so an .mkv is unplayable in a <video>
// however ordinary its contents. ffmpeg repackages the same streams into a
// fragmented MP4 that a browser will accept — usually without touching the
// video at all, since most releases are already H.264 inside.
//
// ffmpeg reads the file back through our own loopback stream URL rather than
// through a pipe. That matters: the HTTP demuxer can issue byte ranges, so
// `-ss` seeks the source properly and probing does not have to drag the whole
// file through stdin.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'

/**
 * Where ffmpeg is, in both worlds.
 *
 * Packaged: build/ffmpeg/<platform>-<arch>/ was copied into the app's
 * resources by electron-builder, which is the only way a cross-built
 * installer gets a binary for the machine it will actually run on —
 * ffmpeg-static resolves against whoever ran `npm install`.
 *
 * Development: ffmpeg-static's own binary, which is correct by definition
 * because this machine installed it.
 */
function resolveFfmpeg () {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, exe)
    if (fs.existsSync(packaged)) return packaged
  }
  return String(ffmpegStatic || '').replace(/app\.asar(?![\w.])/, 'app.asar.unpacked')
}

export const FFMPEG = resolveFfmpeg()

/** Codecs a browser will play if we hand them over untouched. */
const VIDEO_COPY_OK = /^(h264|vp8|vp9|av1)$/
const AUDIO_COPY_OK = /^(aac|mp3|opus|vorbis|flac)$/

const RE_DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
const RE_VIDEO = /Stream #\d+:\d+.*?: Video: (\w+)/
const RE_AUDIO = /Stream #\d+:\d+.*?: Audio: (\w+)/
// e.g. "Stream #0:2(eng): Subtitle: subrip (default)"
const RE_SUBTITLE = /Stream #\d+:\d+(?:\((\w+)\))?.*?: Subtitle: (\w+)/g

/**
 * Subtitle formats that are text and can therefore become WebVTT. The others
 * (PGS from Blu-ray, VobSub from DVD) are bitmap images of text — turning
 * those into a <track> would need OCR, so they are listed but not offered.
 */
const TEXT_SUBTITLES = /^(subrip|srt|ass|ssa|mov_text|webvtt|text|micro_dvd)$/

/** ISO 639-2 to the two-letter tags a browser's track picker expects. */
const LANG3 = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it',
  por: 'pt', dut: 'nl', nld: 'nl', rus: 'ru', pol: 'pl', jpn: 'ja', chi: 'zh',
  zho: 'zh', kor: 'ko', ara: 'ar', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  tur: 'tr', ces: 'cs', cze: 'cs', gre: 'el', ell: 'el', heb: 'he', hin: 'hi'
}
const shortLang = code => (code ? (LANG3[code.toLowerCase()] || code.slice(0, 2).toLowerCase()) : '')

/**
 * Ask ffmpeg what is inside. Giving it no output file makes it print the
 * stream table and exit non-zero immediately — the cheapest probe there is,
 * and it avoids shipping a second binary just for ffprobe.
 */
export function probe (url, timeoutMs = 15000) {
  return new Promise(resolve => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', url])
    let err = ''
    const done = () => {
      const d = RE_DURATION.exec(err)
      // `-map 0:s:N` indexes subtitle streams among themselves, so the
      // position in this list is exactly the N ffmpeg wants back.
      const subtitles = []
      RE_SUBTITLE.lastIndex = 0
      for (const m of err.matchAll(RE_SUBTITLE)) {
        subtitles.push({
          index: subtitles.length,
          lang: shortLang(m[1]),
          codec: m[2],
          text: TEXT_SUBTITLES.test(m[2])
        })
      }
      resolve({
        duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0,
        video: (RE_VIDEO.exec(err) || [])[1] || null,
        audio: (RE_AUDIO.exec(err) || [])[1] || null,
        subtitles
      })
    }
    const timer = setTimeout(() => { p.kill('SIGKILL'); done() }, timeoutMs)
    p.stderr.on('data', c => { err += c })
    p.on('error', () => {
      clearTimeout(timer)
      resolve({ duration: 0, video: null, audio: null, subtitles: [] })
    })
    p.on('close', () => { clearTimeout(timer); done() })
  })
}

/**
 * The subtitle streams that can become a <track>. Bitmap formats (PGS from
 * Blu-ray, VobSub from DVD) are pictures of text and would need OCR, so they
 * are dropped rather than offered and then failing to load.
 */
export const playableSubtitles = (subtitles = []) => subtitles.filter(s => s.text)

/**
 * Decide how each stream has to be handled. Copying is free; transcoding
 * video is not, so it is reported back to the caller and surfaced in the UI
 * rather than silently pinning a CPU core.
 */
export function planFor ({ video, audio }) {
  const videoCopy = !video || VIDEO_COPY_OK.test(video)
  const audioCopy = !audio || AUDIO_COPY_OK.test(audio)
  return {
    video,
    audio,
    videoCopy,
    audioCopy,
    // Only a video re-encode is expensive enough to warn about; AAC from AC3
    // is a rounding error next to it.
    transcoding: !videoCopy
  }
}

/**
 * Spawn a remux and return the process. stdout carries a fragmented MP4,
 * playable while it is still being written.
 *
 * `empty_moov` lets playback start before ffmpeg knows the total duration and
 * `frag_keyframe` puts fragment boundaries on keyframes, so the browser can
 * begin decoding from the first fragment it receives.
 */
export function remux (url, { start = 0, plan }) {
  const args = ['-hide_banner', '-loglevel', 'error']

  // -ss before -i seeks by reading the source's index rather than decoding up
  // to the mark, which is what makes a seek into a 8 GB file near-instant.
  if (start > 0) args.push('-ss', String(start))

  args.push('-i', url)

  args.push('-c:v', plan.videoCopy ? 'copy' : 'libx264')
  if (!plan.videoCopy) args.push('-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p')

  args.push('-c:a', plan.audioCopy ? 'copy' : 'aac')
  if (!plan.audioCopy) args.push('-ac', '2', '-b:a', '160k')

  args.push(
    // default_base_moof (not default_base_is_moof — ffmpeg names the option
    // after the atom it writes, not after the flag inside it).
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  )

  return spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Pull one embedded subtitle stream out as WebVTT.
 *
 * Cues are scattered through the whole container, so ffmpeg reads the file
 * end to end — cheap once the torrent has finished, and a reason not to mark
 * an embedded track `default` while it is still downloading.
 */
export function extractSubtitles (url, streamIndex, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-i', url,
      '-map', `0:s:${Number(streamIndex)}`,
      '-f', 'webvtt', 'pipe:1'
    ])
    const out = []
    let err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('subtitle extraction timed out')) }, timeoutMs)
    p.stdout.on('data', c => out.push(c))
    p.stderr.on('data', c => { err += String(c).slice(0, 1000) })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => {
      clearTimeout(timer)
      const body = Buffer.concat(out).toString('utf8')
      if (!body.trim()) reject(new Error(err.trim() || `ffmpeg exited ${code}`))
      else resolve(body)
    })
  })
}

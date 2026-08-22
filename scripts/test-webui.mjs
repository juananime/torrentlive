// Pure render tests for the served web UI: container detection, the VLC
// fallback, subtitle conversion, and — most importantly — HTML escaping,
// since torrent and file names arrive from strangers.
//
//   npm run test:webui

import { renderIndex, renderWatch, browserPlayable, srtToVtt, subtitleLang, prefersHls } from '../electron/webui.js'
import { planFor, FFMPEG, playableSubtitles } from '../electron/remux.js'
import { rank, titleAffinity, searchTitle, osHash, HASH_CHUNK } from '../electron/subtitles.js'

let pass = 0, fail = 0
const ok = (n, c, d='') => { c ? pass++ : fail++; console.log(`${c?'  ok  ':' FAIL '} ${n}${d?' — '+d:''}`) }

// --- container detection
for (const n of ['a.mkv','a.avi','a.ts','a.m2ts','a.wmv','a.divx'])
  ok(`${n} flagged VLC-only`, !browserPlayable(n))
for (const n of ['a.mp4','a.m4v','a.webm','a.mp3','a.jpg'])
  ok(`${n} browser-playable`, browserPlayable(n))

// --- watch page for an mkv shows the fallback up front
const mkv = renderWatch({
  torrent: { infoHash: 'a'.repeat(40), name: 'Show', files: [] },
  file: { index: 0, name: 'Show.S01E01.1080p.mkv', length: 2e9, progress: 0.2, mime: 'video/x-matroska' },
  subtitles: [], totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 },
  absolute: 'http://192.168.1.135:8842/stream/' + 'a'.repeat(40) + '/0'
})
ok('mkv fallback visible', mkv.includes('id="fb"') && !mkv.includes('id="fb" hidden'))
ok('mkv names the container', mkv.includes('.mkv is not a container'))
ok('mkv offers vlc:// link', mkv.includes('href="vlc://http://192.168.1.135:8842/stream/'))
ok('mkv shows copyable URL', /<input class="url" value="http:\/\/192\.168/.test(mkv))

const mp4 = renderWatch({
  torrent: { infoHash: 'b'.repeat(40), name: 'Sintel', files: [] },
  file: { index: 0, name: 'Sintel.mp4', length: 1e8, progress: 1, mime: 'video/mp4' },
  subtitles: [{ index: 1, lang: 'en', label: 'Sintel.en.srt' }],
  totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y'
})
ok('mp4 fallback hidden', mp4.includes('id="fb" hidden'))
ok('mp4 has default subtitle track', mp4.includes('srclang="en"') && mp4.includes(' default>'))
ok('subs link is bare', mp4.includes('/subs/' + 'b'.repeat(40) + '/1"'))

// --- XSS: torrent and file names come from strangers
const evil = '"><script>alert(1)</script>'
const idx = renderIndex({
  torrents: [{ infoHash: 'c'.repeat(40), name: evil, length: 1, progress: 0, paused: false,
    files: [{ index: 0, name: evil + '.mp4', length: 1, progress: 0, mime: 'video/mp4' }] }],
  totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }
})
ok('index escapes torrent name', !idx.includes('<script>alert(1)</script>'))
ok('index escapes file name', idx.includes('&quot;&gt;&lt;script&gt;'))
const w = renderWatch({
  torrent: { infoHash: 'c'.repeat(40), name: evil, files: [] },
  file: { index: 0, name: evil + '.mp4', length: 1, progress: 0, mime: 'video/mp4' },
  subtitles: [{ index: 1, lang: 'en', label: evil }],
  totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y'
})
ok('watch escapes everywhere', !w.includes('<script>alert(1)</script>'))
ok('watch escapes <title>', /<title>&quot;&gt;&lt;script&gt;/.test(w))

// --- srt -> vtt
const srt = '1\r\n00:01:47,250 --> 00:01:50,500\r\nHola.\r\n'
const vtt = srtToVtt(srt)
ok('vtt header', vtt.startsWith('WEBVTT\n\n'))
ok('vtt decimal point', vtt.includes('00:01:47.250 --> 00:01:50.500'))
ok('vtt strips CR', !vtt.includes('\r'))
ok('lang from filename', subtitleLang('Sintel.pt.srt') === 'pt', subtitleLang('Sintel.pt.srt'))
ok('no lang when absent', subtitleLang('subs.srt') === '')

// --- regressions found in the browser
const many = renderWatch({
  torrent: { infoHash: 'd'.repeat(40), name: 'S', files: [] },
  file: { index: 9, name: 'S.mp4', length: 1, progress: 1, mime: 'video/mp4' },
  subtitles: [{index:0,lang:'de',label:'de'},{index:1,lang:'en',label:'en'},{index:2,lang:'es',label:'es'}],
  totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y'
})
ok('english is the default track', /srclang="en"\s*\n?\s*src="[^"]*" default>/.test(many) || many.includes('srclang="en"\n    src="/subs/' + 'd'.repeat(40) + '/1" default>'))
ok('german is NOT default', !/srclang="de"[\s\S]{0,80}?default>/.test(many))
const noEn = renderWatch({
  torrent: { infoHash: 'e'.repeat(40), name: 'S', files: [] },
  file: { index: 0, name: 'S.mp4', length: 1, progress: 1, mime: 'video/mp4' },
  subtitles: [{index:1,lang:'fr',label:'fr'}],
  totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y'
})
ok('no default when english absent', !noEn.includes(' default>'))
ok('watch page opts out of auto-reload', many.includes('data-count="-1"'))
ok('index opts in to auto-reload', idx.includes('data-count="1"'))

// --- remux planning: what gets copied vs re-encoded
const h264ac3 = planFor({ video: 'h264', audio: 'ac3' })
ok('h264 video is copied', h264ac3.videoCopy)
ok('ac3 audio is converted', !h264ac3.audioCopy)
ok('h264+ac3 is not a transcode', !h264ac3.transcoding)
const hevc = planFor({ video: 'hevc', audio: 'aac' })
ok('hevc is re-encoded', !hevc.videoCopy && hevc.transcoding)
ok('aac audio is copied', hevc.audioCopy)
for (const c of ['vp9','av1','vp8']) ok(`${c} copied`, planFor({ video: c, audio: 'opus' }).videoCopy)
ok('ffmpeg path resolves', typeof FFMPEG === 'string' && FFMPEG.length > 0)
ok('ffmpeg path escapes asar', !/app\.asar[\\/]/.test(FFMPEG.replace('app.asar.unpacked','')))

// --- watch page switches to /remux when a plan is present
const mkvPlan = renderWatch({
  torrent: { infoHash: 'f'.repeat(40), name: 'X', files: [] },
  file: { index: 0, name: 'X.mkv', length: 1, progress: 1, mime: 'video/x-matroska' },
  subtitles: [], totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y',
  plan: h264ac3, duration: 1200
})
ok('mkv sources from /remux', mkvPlan.includes('src="/remux/' + 'f'.repeat(40) + '/0?start=0"'))
ok('seek base points at /remux', mkvPlan.includes('data-base="/remux/' + 'f'.repeat(40) + '/0?start="'))
ok('mkv gets a seek strip', mkvPlan.includes('id="seek"') && mkvPlan.includes('data-duration="1200"'))
ok('mkv hides the VLC fallback', mkvPlan.includes('id="fb" hidden'))
ok('mkv explains the plan', mkvPlan.includes('copied') && mkvPlan.includes('ac3'))
ok('mp4 has no seek strip', !mp4.includes('id="seek"'))
ok('mp4 sources from /stream', mp4.includes('src="/stream/'))

// --- who needs HLS instead of a progressive stream
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const EDGE = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0'
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Gecko/20100101 Firefox/121.0'
const TIZEN = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.0 TV Safari/537.36'
const WEBOS = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.41 (KHTML, like Gecko) Chrome/38 Safari/537.41'
ok('safari needs hls', prefersHls(SAFARI))
ok('ios safari needs hls', prefersHls(IOS))
ok('tizen tv needs hls', prefersHls(TIZEN))
ok('webos tv needs hls', prefersHls(WEBOS))
ok('chrome does not', !prefersHls(CHROME))
ok('edge does not', !prefersHls(EDGE))
ok('firefox does not', !prefersHls(FIREFOX))
ok('empty UA does not', !prefersHls(''))

const hlsPage = renderWatch({
  torrent: { infoHash: 'a'.repeat(40), name: 'X', files: [] },
  file: { index: 3, name: 'X.mkv', length: 1, progress: 1, mime: 'video/x-matroska' },
  subtitles: [], totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y',
  plan: planFor({ video: 'h264', audio: 'ac3' }), duration: 600, hls: true
})
ok('hls page sources the playlist', hlsPage.includes('src="/hls/' + 'a'.repeat(40) + '/3/index.m3u8"'))
ok('hls page drops the seek strip', !hlsPage.includes('id="seek"'))
ok('hls page says why', hlsPage.includes('HLS (this browser needs segments'))

// --- embedded subtitles
ok('bitmap subs are dropped', playableSubtitles([
  { index: 0, lang: 'en', codec: 'subrip', text: true },
  { index: 1, lang: 'en', codec: 'hdmv_pgs_subtitle', text: false },
  { index: 2, lang: 'fr', codec: 'ass', text: true }
]).map(s => s.index).join(',') === '0,2')
ok('no subs is not a crash', playableSubtitles(undefined).length === 0)

const subbed = renderWatch({
  torrent: { infoHash: 'b'.repeat(40), name: 'X', files: [] },
  file: { index: 2, name: 'X.mkv', length: 1, progress: 1, mime: 'video/x-matroska' },
  subtitles: [], totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y',
  plan: planFor({ video: 'h264', audio: 'ac3' }), duration: 60,
  embedded: [{ index: 0, lang: 'en', codec: 'subrip', text: true },
             { index: 1, lang: 'es', codec: 'subrip', text: true }]
})
ok('embedded track points at /esubs', subbed.includes('src="/esubs/' + 'b'.repeat(40) + '/2/1"'))
ok('embedded track is named by language', subbed.includes('label="English (embedded)"'))
ok('embedded track keeps srclang', subbed.includes('srclang="es"'))
ok('embedded tracks are never default', !subbed.includes(' default>'))
ok('note mentions the tracks', subbed.includes('2 embedded subtitle tracks'))

const oneSub = renderWatch({
  torrent: { infoHash: 'c'.repeat(40), name: 'X', files: [] },
  file: { index: 0, name: 'X.mkv', length: 1, progress: 1, mime: 'video/x-matroska' },
  subtitles: [], totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y',
  plan: planFor({ video: 'h264', audio: 'aac' }), duration: 60,
  embedded: [{ index: 0, lang: '', codec: 'subrip', text: true }]
})
const flat = t => t.replace(/\s+/g, ' ')
ok('singular wording for one track', flat(oneSub).includes('1 embedded subtitle track available'))
ok('plural wording for two', flat(subbed).includes('2 embedded subtitle tracks available'))
ok('unlabelled language falls back', oneSub.includes('label="Track 1 (embedded)"'))

// Sibling .srt files and embedded tracks coexist on the same element.
const both = renderWatch({
  torrent: { infoHash: 'd'.repeat(40), name: 'X', files: [] },
  file: { index: 0, name: 'X.mkv', length: 1, progress: 1, mime: 'video/x-matroska' },
  subtitles: [{ index: 5, lang: 'en', label: 'X.en.srt' }],
  totals: { downloadSpeed: 0, uploadSpeed: 0, peers: 0 }, absolute: 'http://x/y',
  plan: planFor({ video: 'h264', audio: 'aac' }), duration: 60,
  embedded: [{ index: 0, lang: 'fr', codec: 'subrip', text: true }]
})
ok('sibling file track survives', both.includes('src="/subs/' + 'd'.repeat(40) + '/5"'))
ok('sibling file track is default', /src="\/subs\/d+\/5" default>/.test(both.replace(/\n\s*/g, ' ')) || both.includes('/5" default>'))
ok('embedded track sits alongside', both.includes('src="/esubs/' + 'd'.repeat(40) + '/0/0"'))

// --- subtitle finder
ok('release noise stripped', searchTitle('The.Matrix.1999.1080p.BluRay.x264.DTS-FGT.mkv') === 'The Matrix 1999',
   searchTitle('The.Matrix.1999.1080p.BluRay.x264.DTS-FGT.mkv'))
ok('channel layout stripped', searchTitle('Breaking.Bad.S03E07.720p.WEB-DL.AAC2.0.H264-GRP.mkv') === 'Breaking Bad S03E07',
   searchTitle('Breaking.Bad.S03E07.720p.WEB-DL.AAC2.0.H264-GRP.mkv'))
ok('title numbers survive', searchTitle('Blade.Runner.2049.2017.1080p.BluRay.x264-SPARKS.mkv') === 'Blade Runner 2049 2017',
   searchTitle('Blade.Runner.2049.2017.1080p.BluRay.x264-SPARKS.mkv'))

ok('title affinity hits', titleAffinity('sintel_en.srt', '', 'Sintel') === 1)
ok('title affinity misses', titleAffinity('Star.Wars.Episode.IX.srt', '', 'Sintel') === 0)
ok('short words do not match everything', titleAffinity('the.and.srt', '', 'The Matrix') === 0)

// The real shape of the bug this ordering exists for: OpenSubtitles flags a
// Star Wars subtitle as an exact hash match for Sintel, with 44x the downloads.
const sub = (id, file, dl, mh) => ({
  attributes: { files: [{ file_id: id, file_name: file }], download_count: dl,
                language: 'en', moviehash_match: mh, release: '' }
})
const ranked = rank(
  [sub(1, 'Star.Wars.Episode.IX.srt', 364404, true), sub(2, 'sintel_en.srt', 8223, true)],
  [sub(3, 'Sintel (2010).eng.srt', 1488, undefined)],
  'Sintel'
)
ok('correct hash match outranks polluted one', ranked[0].fileId === 2, `got ${ranked[0].name}`)
ok('polluted hash match still listed', ranked[1].fileId === 1)
ok('name-only results come last', ranked[2].fileId === 3)
ok('hash flag only from the server', ranked[2].exact === false)
ok('dedup by file id', rank([sub(9, 'a.srt', 1, true)], [sub(9, 'a.srt', 1, undefined)], 'a').length === 1)

// OSDb hash: size plus every LE u64 in the first and last 64 KiB.
const zeros = Buffer.alloc(HASH_CHUNK * 2)
const reader = async (s, e) => zeros.subarray(s, e + 1)
const h = await osHash(zeros.length, reader)
ok('hash is 16 hex chars', /^[0-9a-f]{16}$/.test(h), h)
ok('hash of all-zero file is its size', h === BigInt(zeros.length).toString(16).padStart(16, '0'), h)
let tooSmall = false
try { await osHash(1024, reader) } catch { tooSmall = true }
ok('tiny files rejected', tooSmall)

console.log(`\n${pass}/${pass+fail} passed`)
process.exit(fail ? 1 : 0)

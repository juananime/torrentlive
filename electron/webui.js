// ---------------------------------------------------------------------------
// Web UI served by the stream server.
//
// This is what a LAN client sees when it opens the server root: an index of
// every torrent and which of its files can be played, and a watch page with a
// real <video>. It follows the same Ableton Live rules as the desktop UI —
// flat, charcoal, no rounded corners, yellow for selection, green for meters.
//
// Everything here renders torrent-supplied strings (file and torrent names
// come from a magnet link or a .torrent, i.e. from a stranger), so every
// interpolation goes through esc(). No inline event handlers, no innerHTML.
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESCAPES[c])

const KB = 1024
export function bytes (n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(KB)))
  return `${(n / KB ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}
export const speed = n => (n > 0 ? `${bytes(n)}/s` : '—')
const pct = p => `${Math.floor((p || 0) * 100)}%`

/** Files worth offering a player for. Images are included — they render too. */
export const isStreamable = mime => /^(video|audio|image)\//.test(mime)

/**
 * Containers no browser will open, however good the codecs inside are.
 * Matroska and AVI are the two that matter for torrents: an .mkv is usually
 * H.264 or HEVC with AC3/DTS audio, and no engine ships a Matroska demuxer.
 * These still stream perfectly to VLC/Infuse/mpv, so the watch page offers
 * that route instead of silently showing a black rectangle.
 */
export const browserPlayable = name => !/\.(mkv|avi|ts|m2ts|wmv|flv|divx)$/i.test(name)

/**
 * Does this client need HLS rather than a progressive fragmented MP4?
 *
 * WebKit refuses a media source that cannot serve byte ranges, which a live
 * remux never can, so Safari shows an unplayable placeholder where Chrome
 * plays happily. WebKit browsers get HLS instead — which they support
 * natively, no JavaScript player required. Smart-TV browsers are the same
 * family and are matched explicitly, since their UA strings vary.
 */
export function prefersHls (userAgent = '') {
  const ua = String(userAgent)
  if (/Tizen|Web0S|WebOS|SmartTV|BRAVIA|AppleTV|CrKey/i.test(ua)) return true
  // Chrome and Edge both claim "Safari" in their UA; real Safari does not
  // claim Chrome. iOS Chrome (CriOS) is WebKit underneath, so it counts too.
  if (/CriOS|FxiOS/i.test(ua)) return true
  return /Safari/i.test(ua) && !/Chrome|Chromium|Edg\//i.test(ua)
}

const CSS = `
:root{--deep:#121212;--app:#1c1c1c;--panel:#242424;--surface:#2e2e2e;--raised:#3a3a3a;
--line:#101010;--edge:#4a4a4a;--text:#c8c8c8;--bright:#efefef;--dim:#7a7a7a;--faint:#5a5a5a;
--accent:#ffe900;--blue:#35a3e8;--green:#79d13b;
--mono:"SF Mono",ui-monospace,Menlo,Monaco,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--deep);color:var(--text);font:11px/1.35 -apple-system,"Helvetica Neue",Arial,sans-serif;
-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.label{font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim)}

header{background:var(--surface);border-bottom:1px solid var(--line);display:flex;align-items:center;
gap:10px;padding:0 12px;height:40px;position:sticky;top:0;z-index:2}
header b{font-size:12px;letter-spacing:.14em;color:var(--bright)}
header .tag{font-size:9px;letter-spacing:.14em;color:var(--accent)}
.spacer{margin-left:auto}
.readout{display:flex;flex-direction:column;line-height:1.1;padding:0 9px;border-left:1px solid var(--line)}
.readout .v{font-family:var(--mono);font-size:11px;color:var(--bright)}
.readout .v.dl{color:var(--green)}.readout .v.ul{color:var(--blue)}

main{padding:1px}
.tor{background:var(--panel);margin-bottom:1px}
.tor>.head{background:var(--app);height:26px;display:flex;align-items:center;gap:8px;padding:0 10px;
border-bottom:1px solid var(--line)}
.tor>.head .nm{color:var(--bright);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tor>.head .st{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--faint);flex:none}
.swatch{width:7px;height:7px;flex:none;background:var(--accent)}

.row{display:grid;grid-template-columns:32px 1fr 90px 62px 76px;align-items:center;gap:8px;
min-height:26px;padding:2px 10px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
a.row:hover{background:var(--surface)}
a.row:hover .nm{color:var(--accent)}
.row.dim{color:var(--faint)}
.kind{font-size:8px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);
border:1px solid var(--edge);padding:0 3px;text-align:center}
.row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .r{text-align:right;font-family:var(--mono);font-size:10px}
.meter{height:6px;background:#171717;border:1px solid var(--edge);position:relative}
.meter i{position:absolute;inset:0 auto 0 0;background:var(--green)}
.meter i.full{background:var(--blue)}

.empty{padding:40px 12px;text-align:center;color:var(--faint);background:var(--panel)}
.empty code{color:var(--dim);font-family:var(--mono)}

.stage{background:#0d0d0d;display:flex;align-items:center;justify-content:center;min-height:50vh}
.stage video,.stage audio,.stage img{max-width:100%;max-height:78vh;display:block}
.stage audio{width:min(600px,90vw)}
.foot{background:var(--app);display:flex;align-items:center;gap:10px;padding:7px 10px;
border-top:1px solid var(--line);flex-wrap:wrap}
.back{display:inline-block;background:var(--raised);border:1px solid var(--edge);padding:2px 9px;
font-size:10px;color:var(--text)}
.back:hover{background:var(--accent);border-color:var(--accent);color:#141414}

.fallback{background:var(--panel);border-top:1px solid var(--line);padding:14px 12px;line-height:1.5}
.fallback b{color:var(--accent)}
.fallback p{margin:8px 0;color:var(--dim);max-width:70ch}
.fallback .url{width:100%;max-width:70ch;background:#171717;border:1px solid var(--edge);color:var(--bright);
font-family:var(--mono);font-size:11px;padding:5px 7px;border-radius:0}
.hint{font-size:8px;letter-spacing:.06em;color:var(--accent);border:1px solid var(--accent);padding:0 3px}

.seek{background:var(--app);border-top:1px solid var(--line);display:flex;align-items:center;gap:10px;padding:7px 10px}
.seek input[type=range]{flex:1;accent-color:var(--accent);height:4px}
.seek .note{color:var(--faint);font-size:9px}
.note.remux{background:var(--panel);border-top:1px solid var(--line);padding:7px 10px;color:var(--dim);line-height:1.5}
.note.remux b{color:var(--accent)}

/* Subtitle finder */
.finder{background:var(--panel);border-top:1px solid var(--line);padding:9px 10px}
.finder .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.finder select{background:#171717;color:var(--bright);border:1px solid var(--edge);border-radius:0;
font:inherit;font-size:10px;height:20px;padding:0 4px}
.finder .msg{color:var(--faint);font-size:10px}
.finder .msg.bad{color:var(--accent)}
.results{margin-top:8px;max-height:230px;overflow-y:auto;border-top:1px solid var(--line)}
.results button{display:grid;grid-template-columns:30px 1fr 54px 64px;gap:8px;align-items:center;
width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);
color:var(--text);font:inherit;font-size:11px;padding:4px 2px;cursor:default}
.results button:hover{background:var(--surface);color:var(--bright)}
.results button[aria-pressed=true]{background:var(--accent);color:#141414}
.results .lg{font-family:var(--mono);font-size:10px;text-transform:uppercase}
.results .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.results .dl{text-align:right;font-family:var(--mono);font-size:10px;color:var(--faint)}
.results button[aria-pressed=true] .dl{color:rgba(0,0,0,.6)}
.tagx{font-size:8px;letter-spacing:.06em;text-transform:uppercase;padding:0 3px;border:1px solid var(--edge);color:var(--faint)}
.tagx.exact{color:var(--green);border-color:var(--green)}
`

const JS = `
// Keep progress and speeds live without reloading the page.
async function tick () {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) return;
    const s = await r.json();
    for (const [k, v] of Object.entries(s.files)) {
      const el = document.querySelector('[data-p="' + CSS.escape(k) + '"]');
      if (el) { el.style.width = Math.min(100, v * 100) + '%'; el.classList.toggle('full', v >= 1); }
      const t = document.querySelector('[data-t="' + CSS.escape(k) + '"]');
      if (t) t.textContent = Math.floor(v * 100) + '%';
    }
    const d = document.getElementById('dl'), u = document.getElementById('ul'), p = document.getElementById('pr');
    if (d) d.textContent = s.downloadSpeed;
    if (u) u.textContent = s.uploadSpeed;
    if (p) p.textContent = s.peers;
    // Only the index rebuilds itself when torrents come and go. The watch page
    // opts out with -1 — reloading it would restart playback every tick.
    const known = Number(document.body.dataset.count);
    if (known >= 0 && s.count !== known) location.reload();
  } catch (e) { /* server went away; next tick retries */ }
}
setInterval(tick, 1500);

// A container the browser cannot demux fails silently — a black rectangle and
// no error text. Surface the VLC route the moment that happens.
const v = document.querySelector('video, audio');
const fb = document.getElementById('fb');
if (v && fb) {
  const reveal = () => { fb.hidden = false; };
  v.addEventListener('error', reveal);
  v.addEventListener('loadedmetadata', () => {
    if (v.videoWidth === 0 && v.tagName === 'VIDEO') reveal();
  });
  // No metadata at all after a few seconds means it never started decoding.
  setTimeout(() => { if (v.readyState === 0) reveal(); }, 6000);
}
const input = document.querySelector('.fallback .url');
if (input) input.addEventListener('focus', () => input.select());

// --- Subtitle finder ------------------------------------------------------
// Results are attached as ordinary <track> elements, so once one is chosen the
// browser's own subtitle menu drives it exactly like an embedded track.
const finder = document.getElementById('finder');
if (finder && v) {
  const btn = document.getElementById('findbtn');
  const langSel = document.getElementById('findlang');
  const msg = document.getElementById('findmsg');
  const box = document.getElementById('findresults');
  const say = (text, bad) => { msg.textContent = text; msg.classList.toggle('bad', !!bad); };
  const added = new Map();

  const choose = (r, button) => {
    for (const b of box.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    // Every track but the chosen one goes back to disabled, so switching
    // between candidates does not stack two sets of captions on screen.
    for (const t of v.textTracks) t.mode = 'disabled';

    let track = added.get(r.fileId);
    if (!track) {
      track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = r.name + ' (found)';
      track.srclang = r.lang || '';
      track.src = '/subfetch/' + encodeURIComponent(r.fileId);
      track.addEventListener('error', () => say('That subtitle could not be downloaded.', true));
      v.appendChild(track);
      added.set(r.fileId, track);
    }
    // The TextTrack object only exists once the element is in the document.
    requestAnimationFrame(() => {
      if (track.track) track.track.mode = 'showing';
      say('Showing ' + r.name);
    });
  };

  const render = results => {
    box.hidden = false;
    box.textContent = '';
    if (!results.length) { say('Nothing found for that language.', true); return; }
    for (const r of results) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      const lg = document.createElement('span'); lg.className = 'lg'; lg.textContent = r.lang || '??';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name;
      if (r.hearingImpaired) nm.textContent += '  [SDH]';
      const tg = document.createElement('span'); tg.className = 'tagx' + (r.exact ? ' exact' : '');
      tg.textContent = r.exact ? 'hash' : 'name';
      const dl = document.createElement('span'); dl.className = 'dl';
      dl.textContent = r.downloads ? r.downloads.toLocaleString() + '↓' : '';
      b.append(lg, nm, tg, dl);
      b.addEventListener('click', () => choose(r, b));
      box.appendChild(b);
    }
    say(results.length + ' found — hash matches are already in sync');
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    say('Searching…');
    try {
      const r = await fetch(finder.dataset.search + '?lang=' + encodeURIComponent(langSel.value),
        { cache: 'no-store' });
      const body = await r.json();
      if (!r.ok) { say(body.error || ('Search failed (' + r.status + ')'), true); box.hidden = true; }
      else render(body.results || []);
    } catch (e) {
      say('Search failed: ' + e.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

// Seek strip for remuxed streams. The stream is generated live from an offset,
// so a seek means restarting ffmpeg at the new mark; everything the page shows
// is therefore offset + the element's own position within that segment.
const seek = document.getElementById('seek');
if (seek && v) {
  const bar = document.getElementById('sk');
  const out = document.getElementById('sktime');
  const total = Number(seek.dataset.duration);
  const fmt = s => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    const p = n => String(n).padStart(2, '0');
    return h ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
  };
  let offset = 0, dragging = false;
  const show = at => { out.textContent = fmt(at) + ' / ' + fmt(total); };

  v.addEventListener('timeupdate', () => {
    if (dragging) return;
    const at = offset + v.currentTime;
    bar.value = Math.min(total, Math.round(at));
    show(at);
  });
  bar.addEventListener('input', () => { dragging = true; show(Number(bar.value)); });
  bar.addEventListener('change', () => {
    dragging = false;
    offset = Number(bar.value);
    v.src = seek.dataset.base + offset;
    v.load();
    v.play().catch(() => {});
    show(offset);
  });
}
`

function shell ({ title, body, count = 0, script = true }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body data-count="${count}">
${body}
${script ? `<script>${JS}</script>` : ''}
</body></html>`
}

function header (totals, extra = '') {
  return `<header>
  <b>TORRENT</b><span class="tag">LIVE</span>
  ${extra}
  <span class="spacer"></span>
  <span class="readout"><span class="label">Down</span><span class="v dl" id="dl">${esc(speed(totals.downloadSpeed))}</span></span>
  <span class="readout"><span class="label">Up</span><span class="v ul" id="ul">${esc(speed(totals.uploadSpeed))}</span></span>
  <span class="readout"><span class="label">Peers</span><span class="v" id="pr">${totals.peers}</span></span>
</header>`
}

const kindOf = mime => (mime.split('/')[0] === 'video' ? 'VID'
  : mime.split('/')[0] === 'audio' ? 'AUD'
    : mime.split('/')[0] === 'image' ? 'IMG' : 'DOC')

/** The index: every torrent, every file, streamable ones linked to /watch. */
export function renderIndex ({ torrents, totals }) {
  const main = torrents.length === 0
    ? `<div class="empty">No torrents yet.<br><br>
       Add one in the desktop app and it appears here.<br>
       <code>Torrent Live → paste a magnet link</code></div>`
    : torrents.map(t => `
  <section class="tor">
    <div class="head">
      <i class="swatch"></i>
      <span class="nm">${esc(t.name)}</span>
      <span class="st">${t.files.length} files · ${esc(bytes(t.length))} · ${pct(t.progress)}${t.paused ? ' · paused' : ''}</span>
    </div>
    ${t.files.map(f => {
      const key = `${t.infoHash}/${f.index}`
      const vlcOnly = isStreamable(f.mime) && !browserPlayable(f.name)
      const cells = `
      <span class="kind">${kindOf(f.mime)}</span>
      <span class="nm">${esc(f.name)}${vlcOnly ? ' <span class="hint">VLC</span>' : ''}</span>
      <span class="meter"><i data-p="${esc(key)}" class="${f.progress >= 1 ? 'full' : ''}" style="width:${Math.min(100, f.progress * 100)}%"></i></span>
      <span class="r" data-t="${esc(key)}">${pct(f.progress)}</span>
      <span class="r">${esc(bytes(f.length))}</span>`
      return isStreamable(f.mime)
        ? `<a class="row" href="/watch/${key}">${cells}</a>`
        : `<div class="row dim">${cells}</div>`
    }).join('')}
  </section>`).join('')

  return shell({
    title: 'Torrent Live',
    body: `${header(totals)}<main>${main}</main>`,
    count: torrents.length
  })
}

/** Offered in the finder's language picker, most-subtitled first. */
const SEARCH_LANGS = [
  ['en', 'English'], ['es', 'Spanish'], ['pt-br', 'Portuguese (BR)'], ['pt-pt', 'Portuguese'],
  ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['nl', 'Dutch'],
  ['pl', 'Polish'], ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic'],
  ['zh-cn', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['sv', 'Swedish'],
  ['da', 'Danish'], ['fi', 'Finnish'], ['no', 'Norwegian'], ['cs', 'Czech'],
  ['el', 'Greek'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['ro', 'Romanian']
]

const clock = s => {
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  const h = Math.floor(s / 3600); const m = Math.floor(s / 60) % 60; const x = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}

/**
 * The watch page: one file, playing, with any sibling subtitles attached.
 *
 * `plan` is set only for containers the browser cannot open. When present the
 * media comes from /remux instead of /stream, and the page grows a seek strip
 * — a remuxed stream is generated live, so it cannot be range-served and the
 * native scrubber has nothing to scrub.
 */
export function renderWatch ({
  torrent, file, subtitles, totals, absolute, plan, duration, hls, embedded = []
}) {
  const kind = file.mime.split('/')[0]
  const remuxed = !!plan
  // HLS carries its own timeline and seeks natively, so it needs no seek strip.
  const useHls = remuxed && hls
  const src = useHls
    ? `/hls/${torrent.infoHash}/${file.index}/index.m3u8`
    : remuxed
      ? `/remux/${torrent.infoHash}/${file.index}?start=0`
      : `/stream/${torrent.infoHash}/${file.index}`
  // Remuxing turns an unplayable container into a playable one, so the VLC
  // panel is only a fallback for when even that fails.
  const playable = browserPlayable(file.name) || remuxed

  // Two sources of subtitles: sibling .srt/.vtt files in the torrent, and
  // tracks muxed into the container itself. Sibling files are a plain read;
  // embedded ones cost an ffmpeg pass over the whole file, so they are never
  // marked `default` — the browser fetches them only when the viewer picks one.
  const LANG_NAMES = {
    en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
    pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', pl: 'Polish', ja: 'Japanese',
    zh: 'Chinese', ko: 'Korean', ar: 'Arabic', sv: 'Swedish', da: 'Danish',
    fi: 'Finnish', no: 'Norwegian', tr: 'Turkish', cs: 'Czech', el: 'Greek'
  }
  const defaultSub = subtitles.findIndex(s => s.lang === 'en' || s.lang === 'eng')

  const fileTracks = subtitles.map((s, i) => `<track kind="subtitles" label="${esc(s.label)}" srclang="${esc(s.lang)}"
    src="/subs/${torrent.infoHash}/${s.index}"${i === defaultSub ? ' default' : ''}>`)

  const embeddedTracks = embedded.map(s => {
    const name = LANG_NAMES[s.lang] || (s.lang ? s.lang.toUpperCase() : `Track ${s.index + 1}`)
    return `<track kind="subtitles" label="${esc(name)} (embedded)" srclang="${esc(s.lang)}"
    src="/esubs/${torrent.infoHash}/${file.index}/${s.index}">`
  })

  const tracks = [...fileTracks, ...embeddedTracks].join('\n    ')

  const media = kind === 'video'
    ? `<video controls autoplay playsinline src="${esc(src)}">\n    ${tracks}\n  </video>`
    : kind === 'audio'
      ? `<audio controls autoplay src="${esc(src)}"></audio>`
      : `<img src="${esc(src)}" alt="${esc(file.name)}">`

  // Shown immediately for containers we know browsers reject, and revealed by
  // the error handler for anything else that turns out not to decode.
  const fallback = `<div class="fallback" id="fb"${playable ? ' hidden' : ''}>
    <b>${playable ? 'This file will not play in the browser.' : `.${esc(file.name.split('.').pop())} is not a container any browser can open.`}</b>
    <p>The stream itself is fine — it is the browser that has no demuxer for it.
    Play it in <b>VLC</b>, Infuse or mpv instead: copy the URL below and use
    <i>File → Open Network Stream</i>. Seeking works there too.</p>
    <input class="url" value="${esc(absolute)}" readonly spellcheck="false">
    <p><a class="back" href="vlc://${esc(absolute)}">Open in VLC</a>
       <a class="back" href="${esc(src)}">Download / open raw</a></p>
  </div>`

  // A live remux has no seekable index. Dragging this restarts ffmpeg at the
  // new offset, which is why it is a separate strip and not the native bar.
  const seekbar = remuxed && !useHls && duration > 0
    ? `<div class="seek" id="seek" data-base="${esc(`/remux/${torrent.infoHash}/${file.index}?start=`)}"
       data-duration="${Math.floor(duration)}">
    <span class="label">Seek</span>
    <input type="range" id="sk" min="0" max="${Math.floor(duration)}" value="0" step="1">
    <span class="mono" id="sktime">0:00 / ${esc(clock(duration))}</span>
    <span class="note">restarts the stream · lands on the nearest keyframe before the mark</span>
  </div>`
    : ''

  const remuxNote = remuxed
    ? `<div class="note remux">
       Remuxed live for the browser — ${esc(file.name.split('.').pop().toLowerCase())} →
       ${useHls ? 'HLS (this browser needs segments, not a progressive stream)' : 'fragmented MP4'}.
       Video ${plan.videoCopy
         ? `<b>copied</b> (${esc(plan.video || '?')}, no re-encode)`
         : `<b>re-encoded</b> from ${esc(plan.video || '?')} to H.264 — this is CPU-heavy`},
       audio ${plan.audioCopy ? `copied (${esc(plan.audio || '?')})` : `converted from ${esc(plan.audio || '?')} to AAC`}.
       ${embedded.length
         ? `${embedded.length} embedded subtitle track${embedded.length > 1 ? 's' : ''}
            available from the player's subtitle menu — each is extracted on
            first use, which takes a moment on a large file.`
         : ''}
     </div>`
    : ''

  // Only offered for video — nobody is subtitling a jpeg.
  const finder = kind === 'video'
    ? `<div class="finder" id="finder" data-search="/subfinder/${torrent.infoHash}/${file.index}">
    <div class="bar">
      <button class="back" id="findbtn">Find subtitles</button>
      <select id="findlang" aria-label="Subtitle language">
        ${SEARCH_LANGS.map(([c, n]) => `<option value="${esc(c)}"${c === 'en' ? ' selected' : ''}>${esc(n)}</option>`).join('')}
      </select>
      <span class="msg" id="findmsg">Matched by content hash, the way VLC does it.</span>
    </div>
    <div class="results" id="findresults" hidden></div>
  </div>`
    : ''

  const body = `${header(totals, `<a class="back" href="/">← All files</a>`)}
<main>
  <div class="stage">${media}</div>
  ${seekbar}
  ${remuxNote}
  ${finder}
  ${fallback}
  <div class="foot">
    <span class="kind">${kindOf(file.mime)}</span>
    <span class="mono" style="color:var(--bright)">${esc(file.name)}</span>
    <span class="spacer"></span>
    <span class="mono" data-t="${esc(`${torrent.infoHash}/${file.index}`)}">${pct(file.progress)}</span>
    <span class="mono">${esc(bytes(file.length))}</span>
    <a class="back" href="${esc(src)}">Open raw stream</a>
  </div>
</main>`

  return shell({ title: `${file.name} — Torrent Live`, body, count: -1 })
}

/**
 * Only reachable in the narrow window where a connection outlives a rebind,
 * since sharing being off means nothing is listening off-loopback at all.
 */
export function renderForbidden () {
  const body = `<header><b>TORRENT</b><span class="tag">LIVE</span></header>
<main><div class="empty" style="text-align:left;max-width:60ch;margin:0 auto">
  <p style="color:var(--accent);font-size:13px"><b>Sharing is switched off.</b></p>
  <p>Turn it on with <i>Share on LAN…</i> at the bottom of the desktop app's
  sidebar, then reload this page.</p>
</div></main>`
  return shell({ title: 'Sharing is off — Torrent Live', body, script: false })
}

/**
 * SubRip → WebVTT. Browsers refuse .srt outright, and every scene release
 * ships .srt, so the only way subtitles ever appear is to convert on the fly.
 * The formats are line-compatible apart from the header and the decimal comma.
 */
export function srtToVtt (text) {
  return `WEBVTT\n\n${text.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')}`
}

/** "Sintel.en.srt" / "movie.eng.vtt" → a language tag for the <track>. */
export function subtitleLang (name) {
  const m = /\.([a-z]{2,3})\.(srt|vtt)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

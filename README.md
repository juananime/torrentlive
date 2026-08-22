# Torrent Live

A WebTorrent desktop client for macOS with an interface modelled on **Ableton Live**.
Built to run **natively on Apple Silicon with no Rosetta and no compile step**.

---

## Why the Ableton layout works here

Live's session view is a dense grid of coloured clips with level meters, a browser
down the left, and a detail panel across the bottom. That maps onto a torrent
client almost one-for-one:

| Ableton Live | Torrent Live |
| --- | --- |
| Control bar (tempo, transport, CPU meter) | Magnet input, global ↓/↑ read-outs, peers, ratio |
| Browser sidebar (Sounds, Drums, Packs) | Status filters — All / Downloading / Seeding / Paused |
| Session view tracks + clips | One row per torrent, each with its own clip colour |
| Level meters | Progress bars, green → blue when seeding |
| Detail view (clip / device panel) | File list of the selected torrent + streaming player |

Styling rules taken directly from Live: completely flat (no gradients, no
shadows, no rounded corners), panels divided by near-black 1px gaps, monochrome
charcoal chrome, saturated colour reserved for data, and selection drawn as a
solid **yellow fill with black text**.

---

## Running it

```bash
npm install
npm run dev      # Vite dev server + Electron with hot reload
```

Other scripts:

```bash
npm start          # production build, then launch
npm run smoke      # headless self-test: boots the app and asserts it rendered
npm run test:webui # render tests for the served pages (escaping, VLC fallback)
npm run check:native   # audits the dependency tree for x86_64 addons
npm run dist       # build a signed-less arm64 .dmg into release/
```

---

## The no-Rosetta guarantee

Rosetta gets dragged into an Electron app in one of two ways: the Electron
binary itself is x64, or a dependency loads a compiled `.node` addon built for
x86_64. This project closes both doors.

**1. Electron is arm64.** Electron 43 ships native Apple Silicon builds, and
`electron-builder.yml` targets `arch: [arm64]` explicitly. The running app
reports its own architecture in the top-right badge — it reads
`arm64 native` in green, or turns red if it is ever translated.

**2. Nothing is ever compiled.** WebTorrent pulls in five optional native
accelerators:

| Package | What it does | Without it |
| --- | --- | --- |
| `utp-native` | µTP transport | falls back to TCP |
| `node-datachannel` | WebRTC peers in Node | TCP/DHT peers still work |
| `bufferutil` | faster WebSocket masking | pure-JS fallback |
| `utf-8-validate` | faster UTF-8 validation | pure-JS fallback |
| `fs-native-extensions` | file locking hints | no-op |

Every one is an *optional accelerator with a JavaScript fallback*, and every one
ships a prebuilt `darwin-arm64` binary — verified by `npm run check:native`:

```
✓ bufferutil             arm64:1  x86_64-only:0
✓ fs-native-extensions   arm64:1  x86_64-only:0
✓ node-datachannel       arm64:1  x86_64-only:0
✓ utf-8-validate         arm64:1  x86_64-only:0
✓ utp-native             arm64:1  x86_64-only:0
```

`electron-builder.yml` sets `npmRebuild: false`, so packaging never invokes
node-gyp. No compiler, no Xcode toolchain, no chance of an x86_64 object being
linked into an arm64 app — which is the usual route to a "native" build that
silently needs Rosetta.

---

## Architecture

```
electron/main.js      WebTorrent client, IPC handlers, HTTP stream server
electron/webui.js     the pages that server hands to browsers on the LAN
electron/subtitles.js OpenSubtitles finder - OSDb hash, search, download
electron/settings.js  persisted settings (download folder, credentials)
electron/remux.js     ffmpeg wrapper — mkv etc. into browser-playable fMP4
electron/hls.js       HLS segmenter for WebKit clients (Safari, iOS, TVs)
electron/preload.cjs  contextBridge API (sandboxed, CommonJS by necessity)
src/                  React 19 renderer — pure UI, no torrent logic
```

**WebTorrent runs in the main process, not the renderer.** That is a deliberate
choice: the main process can open raw TCP sockets and speak DHT, so the client
reaches the ordinary BitTorrent swarm. A renderer-hosted client would be limited
to WebRTC peers.

**Streaming.** The renderer is sandboxed and cannot read a torrent's chunk
store, so the main process serves each file over HTTP with byte-range support.
Selecting a range tells WebTorrent to prioritise those pieces, so a video plays
before the download finishes and seeking pulls the pieces it needs. The server
sends `Cache-Control: no-store`, since a partially-downloaded file must never
be cached.

**LAN video server.** That same server is the video server (see below). It
binds to `127.0.0.1` on startup; switching sharing on rebinds it to `0.0.0.0`
on the *same port*, so a stream already playing in the app keeps its URL.

**State flow.** The main process pushes a serialised snapshot of every torrent
to the renderer on a 500ms tick. Speeds and progress change continuously, so a
steady tick is simpler and cheaper than storming the renderer with events.

### Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- A restrictive CSP in `index.html`; `media-src` allows only `127.0.0.1`.
  The app itself always plays over loopback, so enabling LAN sharing does not
  widen the renderer's CSP
- External links open in the system browser, never in-app
- The stream server validates the infohash against a 40-hex-character pattern
  before touching any file
- **Sharing is the only access control, and it is off by default.** With it
  off the socket is not bound off-loopback at all, so there is nothing on the
  network to reach. With it on, everything is open to the LAN — see the
  warning under *The video server*
- The served pages interpolate torrent and file names, which come from a
  magnet link — i.e. from a stranger. Every one goes through `esc()`, and
  `npm run test:webui` asserts a `<script>` in a filename stays inert. The
  pages ship a `default-src 'none'` CSP and carry no external references

---

## The video server

The app doubles as a video server for the rest of the house: start a download
and watch it from a phone, a TV, or VLC on another machine while it is still
downloading, with seeking intact.

Open the server root in a browser and you get a **web UI** — every torrent,
every file, progress bars that update live, and a click-to-play watch page:

| Route | What it serves |
| --- | --- |
| `/` | index of all torrents and files; streamable ones link to `/watch` |
| `/watch/<hash>/<index>` | player page — `<video>`, subtitles, raw-URL escape hatch |
| `/stream/<hash>/<index>` | the raw byte-range stream (what VLC wants) |
| `/remux/<hash>/<index>` | mkv etc. repackaged live as fragmented MP4 (Chrome) |
| `/hls/<hash>/<index>/…` | the same, as an HLS playlist + segments (Safari, TVs) |
| `/subs/<hash>/<index>` | sibling `.srt` converted to WebVTT on the fly |
| `/esubs/<hash>/<index>/<n>` | subtitle track `n` pulled out of the container |
| `/subtracks/<hash>/<index>` | what subtitles already exist for a file (JSON) |
| `/subfinder/<hash>/<index>` | search OpenSubtitles by content hash (JSON) |
| `/subfetch/<fileId>` | download a found subtitle, converted to WebVTT |
| `/api/state` | JSON progress, polled by the pages every 1.5s |

### Subtitles

Both places a release keeps them are handled, and they appear together in the
player's own subtitle menu.

**Sibling files.** Any `.srt`/`.vtt` alongside the video in the same torrent.
Browsers refuse SubRip outright, so it is converted to WebVTT as it is served —
comma decimals to dots, `WEBVTT` header prepended. English is selected by
default when the release ships it.

**Embedded tracks**, which is how most `.mkv` releases actually ship them.
Probing lists the subtitle streams; `/esubs/…` runs the chosen one through
ffmpeg into WebVTT and caches the result. ASS/SSA styling is flattened to
plain text — the words survive, the positioning does not.

**Found online**, via the finder described below.

Two deliberate limits:

- **Bitmap subtitles are dropped, not offered.** PGS (Blu-ray) and VobSub
  (DVD) are pictures of text; a `<track>` cannot show them without OCR, so
  they are filtered out rather than listed and then failing to load.
- **Embedded tracks are never marked `default`.** Cues are spread through the
  whole container, so extracting one means ffmpeg reads the file end to end —
  instant on a finished torrent, but it would force the rest of a download.
  The browser fetches a track only when the viewer selects it.

The ⧉ button in the desktop app copies a file's stream URL. What it copies
depends on whether sharing is on.

**Testing on this machine — nothing to switch on.** The server is always
listening on loopback. Copy a URL and paste it into a browser, VLC, or `curl`:

```
http://127.0.0.1:8842/stream/<infohash>/<fileindex>
```

`localhost` works too — it resolves to `::1`, which is also treated as
loopback. This is the quickest way to check the server is serving: open it in
Safari and the video plays, seek bar and all.

**Sharing to other devices** is **off by default**. Turn it on with *Share on
LAN…* at the bottom of the browser sidebar; the read-out above the button
switches from grey `loopback only` to a green `192.168.x.x:8842`.

*Copy web UI link* puts the address on the clipboard. On a television, type it
straight in — there is nothing else to enter:

```
http://192.168.1.24:8842/
```

> ⚠️ **There is no authentication.** While sharing is on, anything on the
> network can open that address, see every torrent by name, and stream all of
> it. That is a deliberate choice — a token was tried and the friction of
> entering it on a TV was not worth what it bought on a home LAN — but it does
> mean the switch is the whole of the access control. Guest wifi, shared
> flats, and office networks are not the place for it.

Your router still blocks inbound traffic, so this is not exposed to the
internet; the reach is exactly "anything already on your wifi".

Details worth knowing:

- **Port 8842 is fixed** (falling back to a random one only if it is taken), so
  URLs survive a restart.
- **Any client that speaks HTTP range works** — Safari/Chrome, VLC, Infuse,
  mpv.
- **`.mkv` is remuxed on the fly** — see below. If that ever fails, the watch
  page falls back to the VLC route rather than a black rectangle, caught via
  the `<video>` error event.
- Toggling sharing drops in-flight connections in order to rebind the port. A
  video playing in the app or on another device re-requests and continues; it
  is not seamless.

`npm run smoke` asserts the switch really is a switch, end-to-end against the
machine's own LAN address: `ECONNREFUSED` while off, `404` (i.e. reaching the
router) while on, `ECONNREFUSED` again after switching off.

---

## The subtitle finder

The same approach as VLC's VLSub: identify the video by a hash of its bytes,
not by its name.

**Where it is.** Both players have it. In the desktop app it is the *Subs* bar
under the player — a source picker, a language, and *Find...*. In the browser
it is the *Find subtitles* panel under the video. Both drive the same endpoints.

**How the query works.** Two searches go out in parallel:

- **By content hash** - the OSDb hash: the file size plus every little-endian
  64-bit word in the first and last 64 KiB. It never touches the middle of the
  file, so it works minutes into a download, and requesting those two ranges
  makes WebTorrent prioritise exactly the pieces needed.
- **By title** - the filename with the scene furniture stripped
  (`The.Matrix.1999.1080p.BluRay.x264.DTS-FGT.mkv` becomes `The Matrix 1999`),
  as a fallback for releases the hash index has never seen.

Results are merged, deduplicated by file id, and ordered: hash matches first,
then subtitles whose name agrees with the title, then by download count.

> That middle criterion is not decoration. OpenSubtitles' hash index contains
> bad entries - a Star Wars subtitle is registered against *Sintel's* hash and
> comes back flagged `moviehash_match: true` with 364,000 downloads behind it.
> Ordering on the flag and the download count alone puts it at the top of
> Sintel. Requiring the name to agree as a tiebreak fixes it without hiding
> anything: the bad entry is still listed, just second.

Picking a result downloads it, converts SubRip to WebVTT, and attaches it as a
`<track>` - from there the player's own subtitle menu drives it.

### Credentials

The finder needs a free OpenSubtitles API key: sign up at **opensubtitles.com**,
then create a consumer at **opensubtitles.com/en/consumers**. Paste it into
*Subtitle Finder* in the sidebar and press **Test** - it runs a real query and
reports the count.

Optionally add your username and password as well; the key alone allows only a
handful of downloads a day, and signing in raises the limit.

Credentials live in `settings.json` under the app's userData directory, written
`0600`. The renderer can set them but never reads them back - it sees only a
`****1234` fingerprint, so the key does not sit in renderer state.

---

## Playing .mkv in a browser

No browser ships a Matroska demuxer, so a `<video>` will not open an `.mkv`
however ordinary its contents. The server repackages it instead: ffmpeg reads
the file back through the loopback stream URL and writes a fragmented MP4 to
`/remux/<hash>/<index>`, which is what the watch page points a `.mkv` at.

Usually nothing is re-encoded. A typical release is already H.264, which is
copied through untouched; only the audio is converted, and AC3 → AAC is
cheap. The watch page states which happened:

> Remuxed live for the browser — mkv → fragmented MP4. Video **copied**
> (h264, no re-encode), audio converted from ac3 to AAC.

HEVC, being unplayable in most browsers, is re-encoded to H.264 at
`-preset veryfast`. That is genuinely CPU-heavy and the page says so.

### Safari, iPhones and televisions need HLS

WebKit refuses a media source that cannot serve byte ranges, and a stream
being generated live never can. So the progressive remux above plays in Chrome
and shows an unplayable placeholder in Safari — which also means every iPhone,
iPad, and most smart-TV browsers, i.e. the entire audience for a LAN video
server.

Those clients get HLS instead: ffmpeg writes four-second segments into a temp
directory and the playlist is served from `/hls/…/index.m3u8`. Safari plays
that natively, no JavaScript player, and gets a **real seek bar** covering
everything already packaged — better than the progressive route. The server
picks per request from the User-Agent; `npm run test:webui` pins that
routing for Safari, iOS, Tizen, webOS, Chrome, Edge and Firefox.

Sessions are reused across requests and reaped after 90 seconds idle, so a
closed tab does not leave an ffmpeg and a directory of segments behind.

**Seeking on the progressive route.** A live remux has no index, so the native
scrubber has nothing to work with and the page adds its own seek strip:
dragging it restarts ffmpeg at the new `?start=`. Two consequences worth
knowing — playback resumes at the nearest keyframe *before* the mark (you
cannot start a copied H.264 stream mid-GOP), and the displayed position can
therefore run ahead of the picture by up to one keyframe interval. The HLS
route has neither problem.

ffmpeg is killed as soon as the client disconnects; otherwise every abandoned
tab would leave one pinned to a core.

> `ffmpeg-static` ships a genuine arm64 binary, so the no-Rosetta guarantee
> survives. `ffprobe-static` does **not** — it puts an x86_64 build inside its
> `darwin/arm64` directory, which is why probing is done with ffmpeg itself
> (`-i` with no output prints the stream table and exits). `check:native` now
> audits bundled executables too, not just `.node` addons, so this cannot
> creep back in unnoticed.

> Torrent lookup deliberately does **not** use `client.get()`. In WebTorrent 3
> that method is `async`, so calling it as a plain getter returns a Promise —
> `.files` is undefined and every stream request 404s. `findTorrent()` scans
> `client.torrents` synchronously instead.

---

## Status

Working: adding torrents by magnet / infohash / `.torrent` file / drag-and-drop,
pause & resume, remove with optional file deletion, reveal in Finder, per-file
progress, streaming playback of video, audio and images while downloading,
LAN streaming to other devices, a browser UI on the server root,
and live remuxing so `.mkv` plays in Chrome, Safari, phones and TVs.

Not yet done: torrent creation and seeding of local files, persisting the
session across restarts, bandwidth limits, sequential-download toggles, and
hardware-accelerated encoding for the HEVC path (it uses libx264 today).

## License

MIT

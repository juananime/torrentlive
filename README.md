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
npm run test:ops   # torrent ops + streaming regression tests (no network)
npm run smoke      # headless self-test: boots the app and asserts it rendered
npm run check:native   # audits the dependency tree for x86_64 addons
npm run icon       # regenerate build/icon.png
```

---

## Installers

```bash
npm run dist       # macOS  → .dmg + .zip (arm64)
npm run dist:win   # Windows → NSIS installer + .zip (x64 and arm64)
npm run dist:all   # both
```

Everything lands in `release/`:

| File | Platform |
| --- | --- |
| `Torrent Live-0.1.0-arm64.dmg` | macOS, Apple Silicon |
| `Torrent Live Setup 0.1.0.exe` | Windows installer, x64 + arm64 in one |
| `Torrent Live-0.1.0-win.zip` | Windows x64, portable |
| `Torrent Live-0.1.0-arm64-win.zip` | Windows arm64, portable |

Both platforms cross-build from a Mac — the Windows installer needs no Wine,
because nothing in the tree is compiled (see below).

**Signing.** The macOS build is signed with whatever local Developer identity
is available but is *not* notarised, so on another machine Gatekeeper will
need right-click → Open the first time. The Windows binaries are unsigned;
SmartScreen will warn until they are signed with a code-signing certificate.
Neither affects the app, only the first-run prompt.

### Demo mode

An empty client shows nothing of the layout, so `WTLIVE_DEMO=1` replaces the
session with sample data for UI work:

```bash
WTLIVE_DEMO=1 npm start

# and to capture screenshots of it:
WTLIVE_DEMO=1 WTLIVE_SHOT=/tmp/shots npm start
```

It swaps the entire state payload instead of injecting into the real client, so
sample numbers can never mix into a genuine session. Preview playback shows a
placeholder in this mode — there is no real data behind the sample entries.

---

## Becoming the default torrent app

Two independent registrations, both declared in `electron-builder.yml`:

| What | Mechanism | Automatic? |
| --- | --- | --- |
| `magnet:` links | `protocols:` → `CFBundleURLTypes` + `app.setAsDefaultProtocolClient()` at startup | yes |
| `.torrent` files | `fileAssociations:` → `CFBundleDocumentTypes` with `LSHandlerRank: Owner` | usually |

Magnet links are claimed on every launch, so they work as soon as the app has
run once. For `.torrent` files macOS decides via LaunchServices: with
`LSHandlerRank: Owner` and no other torrent client installed it picks this app
automatically, but if another client already owns the type the choice is the
user's to make — right-click a `.torrent` → **Get Info** → **Open with** →
Torrent Live → **Change All**. There is no API to force it; the sidebar shows
the magnet status and spells out that manual step.

The app must live in `/Applications` for LaunchServices to register it
reliably.

Handling them correctly needs more than the declarations:

- `open-file` / `open-url` are registered **before** `app.whenReady()`, because
  macOS fires them during launch. Sources arriving before the WebTorrent client
  exists are queued and replayed once it is up — otherwise a cold-start open
  silently does nothing.
- A single-instance lock means double-clicking a second torrent hands off to the
  running app instead of starting a rival client over the same files.
- Windows passes both files and magnet URLs on the command line, so `process.argv`
  is parsed on startup and on `second-instance`.

## Folder permissions on macOS

The app uses the hardened runtime but is **not** sandboxed, so macOS (TCC)
asks once, on the first write into a protected folder — `~/Downloads` being the
default save location. `Info.plist` carries explicit reasons
(`NSDownloadsFolderUsageDescription` and friends) so that prompt explains
itself instead of showing a generic warning.

Picking a folder through **Change folder…** counts as user consent for that
location, so ordinary use is a single prompt on first download. If it is ever
denied by mistake, re-grant it under System Settings → Privacy & Security →
Files and Folders.

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
silently needs Rosetta. It is also why Windows installers cross-build from a
Mac without Wine.

**3. The shipped bundle contains no Intel code at all.** The `mac.files` rules
exclude every non-arm64 prebuild, so the promise holds by construction rather
than by convention. Verifiable on the built app:

```console
$ find "release/mac-arm64/Torrent Live.app" -name '*.node' -exec file {} \;
… utp-native/prebuilds/darwin-arm64/node.napi.node:        Mach-O 64-bit bundle arm64
… fs-native-extensions/prebuilds/darwin-arm64/…:           Mach-O … arm64
… node-datachannel/build/Release/node_datachannel.node:    Mach-O … arm64
… utf-8-validate/prebuilds/darwin-arm64/…:                 Mach-O 64-bit bundle arm64
… bufferutil/prebuilds/darwin-arm64/…:                     Mach-O 64-bit bundle arm64

$ lipo -archs "release/mac-arm64/Torrent Live.app/Contents/MacOS/Torrent Live"
arm64
```

---

## Architecture

```
electron/main.js           WebTorrent client, IPC handlers, window
electron/stream-server.js  loopback HTTP range server for playback
electron/demo-state.js     sample data for UI work (WTLIVE_DEMO only)
electron/preload.cjs       contextBridge API (sandboxed, CommonJS by necessity)
src/                       React 19 renderer — pure UI, no torrent logic
```

> **`client.get()` is async in WebTorrent 3.** It runs the id through
> `parseTorrent` and returns a *Promise*, so using it as though it returned a
> torrent yields `undefined` for `.files`, `.destroy`, `.pause` — breaking
> remove, pause, resume, reveal and streaming all at once, with the only
> symptom being `t.destroy is not a function`. `main.js` therefore uses a
> synchronous `findTorrent()` that scans `client.torrents`. `npm run test:ops`
> locks this behaviour down.

**WebTorrent runs in the main process, not the renderer.** That is a deliberate
choice: the main process can open raw TCP sockets and speak DHT, so the client
reaches the ordinary BitTorrent swarm. A renderer-hosted client would be limited
to WebRTC peers.

**Streaming.** The renderer is sandboxed and cannot read a torrent's chunk
store, so the main process serves each file over `127.0.0.1` with HTTP
byte-range support. Selecting a range tells WebTorrent to prioritise those
pieces, so a video plays before the download finishes and seeking pulls the
pieces it needs. The server binds to loopback only and sends `Cache-Control:
no-store`, since a partially-downloaded file must never be cached.

**State flow.** The main process pushes a serialised snapshot of every torrent
to the renderer on a 500ms tick. Speeds and progress change continuously, so a
steady tick is simpler and cheaper than storming the renderer with events.

### Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- A restrictive CSP in `index.html`; `media-src` allows only `127.0.0.1`
- External links open in the system browser, never in-app
- The stream server binds to loopback and validates the infohash against a
  40-hex-character pattern before touching any file

---

## Status

Working: adding torrents by magnet / infohash / `.torrent` file / drag-and-drop,
pause & resume, remove with optional file deletion, reveal in Finder, per-file
progress, and streaming playback of video, audio and images while downloading.

Not yet done: torrent creation and seeding of local files, persisting the
session across restarts, bandwidth limits, and sequential-download toggles.

## License

MIT

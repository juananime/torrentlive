# WebTorrent Live

A WebTorrent desktop client for macOS with an interface modelled on **Ableton Live**.
Built to run **natively on Apple Silicon with no Rosetta and no compile step**.

---

## Why the Ableton layout works here

Live's session view is a dense grid of coloured clips with level meters, a browser
down the left, and a detail panel across the bottom. That maps onto a torrent
client almost one-for-one:

| Ableton Live | WebTorrent Live |
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
electron/main.js      WebTorrent client, IPC handlers, loopback stream server
electron/preload.cjs  contextBridge API (sandboxed, CommonJS by necessity)
src/                  React 19 renderer — pure UI, no torrent logic
```

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

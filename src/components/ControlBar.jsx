import { useState } from 'react'
import { speed, bytes, looksLikeTorrentSource } from '../lib/format.js'

/**
 * Live's control bar: identity on the left, the "transport" (here: the add
 * field) in the middle, and numeric read-outs pinned right.
 */
export default function ControlBar ({ totals, info, onAdd, onAddFile }) {
  const [value, setValue] = useState('')
  const valid = looksLikeTorrentSource(value)

  const submit = e => {
    e.preventDefault()
    if (!valid) return
    onAdd(value.trim())
    setValue('')
  }

  const native = info && info.arch === 'arm64'

  return (
    <header className="controlbar">
      <div className="brand">
        <b>WebTorrent</b>
        <span>Live</span>
      </div>

      <form className="addbar" onSubmit={submit}>
        <input
          className="input"
          placeholder="Paste a magnet link, info hash, or .torrent URL…"
          value={value}
          spellCheck={false}
          onChange={e => setValue(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={!valid}>Add</button>
        <button className="btn" type="button" onClick={onAddFile}>File…</button>
      </form>

      <div className="readouts">
        <div className="readout">
          <span className="label">Down</span>
          <span className="val dl">{speed(totals.downloadSpeed)}</span>
        </div>
        <div className="readout">
          <span className="label">Up</span>
          <span className="val ul">{speed(totals.uploadSpeed)}</span>
        </div>
        <div className="readout">
          <span className="label">Peers</span>
          <span className="val">{totals.peers}</span>
        </div>
        <div className="readout">
          <span className="label">Ratio</span>
          <span className="val">{(totals.ratio || 0).toFixed(2)}</span>
        </div>
      </div>

      {info && (
        <div
          className={`archbadge${native ? '' : ' warn'}`}
          title={`Electron ${info.versions.electron} · Node ${info.versions.node} · ${info.arch}`}
        >
          <i className="dot" />
          <span>Arch</span>
          <b>{native ? 'arm64 native' : `${info.arch} — translated`}</b>
        </div>
      )}
    </header>
  )
}

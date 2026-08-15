import { useState } from 'react'
import { bytes } from '../lib/format.js'

const FILTERS = [
  { id: 'all',        label: 'All Torrents', swatch: 'var(--text-dim)' },
  { id: 'downloading', label: 'Downloading',  swatch: 'var(--meter-lo)' },
  { id: 'seeding',    label: 'Seeding',      swatch: 'var(--blue)' },
  { id: 'completed',  label: 'Completed',    swatch: 'var(--clip-5)' },
  { id: 'paused',     label: 'Paused',       swatch: 'var(--text-faint)' }
]

/** Live's left-hand browser, repurposed as a status filter list. */
export default function Browser ({ filter, onFilter, counts, info, onDrop, onChooseFolder }) {
  const [over, setOver] = useState(false)

  const handleDrop = e => {
    e.preventDefault()
    setOver(false)
    const text = e.dataTransfer.getData('text/plain')
    const files = [...(e.dataTransfer.files || [])]
    // File.path no longer exists in modern Electron; resolve via the preload.
    if (files.length) return onDrop(files.map(f => window.wt.pathForFile(f)).filter(Boolean))
    if (text) onDrop([text])
  }

  return (
    <nav className="browser">
      <div className="browser-section">
        <span className="label">Categories</span>
        {FILTERS.map(f => (
          <div
            key={f.id}
            className={`browser-item${filter === f.id ? ' active' : ''}`}
            onClick={() => onFilter(f.id)}
          >
            <i className="swatch" style={{ background: f.swatch }} />
            {f.label}
            <span className="count">{counts[f.id] ?? 0}</span>
          </div>
        ))}
      </div>

      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
      >
        Drop a .torrent file
        <br />or magnet link here
      </div>

      <div className="browser-foot">
        <span className="label">Save To</span>
        <div className="pathline">{info?.downloadPath || '…'}</div>
        <button className="btn" onClick={onChooseFolder}>Change folder…</button>
      </div>
    </nav>
  )
}

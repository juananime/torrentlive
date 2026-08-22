import { useState } from 'react'
import { bytes } from '../lib/format.js'
import SubtitleSettings from './SubtitleSettings.jsx'

const FILTERS = [
  { id: 'all',        label: 'All Torrents', swatch: 'var(--text-dim)' },
  { id: 'downloading', label: 'Downloading',  swatch: 'var(--meter-lo)' },
  { id: 'seeding',    label: 'Seeding',      swatch: 'var(--blue)' },
  { id: 'completed',  label: 'Completed',    swatch: 'var(--clip-5)' },
  { id: 'paused',     label: 'Paused',       swatch: 'var(--text-faint)' }
]

/** Live's left-hand browser, repurposed as a status filter list. */
export default function Browser ({
  filter, onFilter, counts, info, server, onDrop, onChooseFolder, onToggleLan,
  onCopyWebLink, onToast
}) {
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
        <span className="label">Video Server</span>
        <div className={`serverline${server?.lan ? ' live' : ''}`}>
          <i className="dot" />
          <span className="mono">
            {server?.lan
              ? `${server.host}:${server.port}`
              : `loopback only · :${server?.port || '—'}`}
          </span>
        </div>
        <button className="btn" onClick={() => onToggleLan(!server?.lan)}>
          {server?.lan ? 'Stop sharing on LAN' : 'Share on LAN…'}
        </button>
        {server?.lan && (
          <>
            <button className="btn" onClick={onCopyWebLink}>Copy web UI link</button>
            {server.addresses.length > 1 && (
              <div className="pathline">also on {server.addresses.slice(1).join(', ')}</div>
            )}
            <div className="pathline warn">
              Open — anyone on this network can browse and watch everything
              here. Switch it off when you are done.
            </div>
          </>
        )}

        <SubtitleSettings onToast={onToast} />

        <span className="label" style={{ marginTop: 3 }}>Save To</span>
        <div className="pathline">{info?.downloadPath || '…'}</div>
        <button className="btn" onClick={onChooseFolder}>Change folder…</button>
      </div>
    </nav>
  )
}

import { bytes, speed, pct, eta, clipColor } from '../lib/format.js'

function Meter ({ t }) {
  const cls = t.paused ? 'paused' : t.done ? 'done' : ''
  return (
    <div className="meter" title={pct(t.progress)}>
      <div className={`fill ${cls}`} style={{ width: `${Math.min(100, t.progress * 100)}%` }} />
      <div className="pct">{t.ready ? pct(t.progress) : 'metadata…'}</div>
    </div>
  )
}

/**
 * The session view: one row per torrent, laid out like Live's track rows with
 * a colour stripe, a level-meter progress bar, and numeric columns.
 */
export default function SessionView ({ torrents, selected, onSelect, onPause, onResume, onRemove, onReveal }) {
  if (!torrents.length) {
    return (
      <section className="session">
        <Head />
        <div className="empty">
          <h3>No torrents in this view</h3>
          <p>
            Paste a magnet link in the bar above, drop a <code>.torrent</code> file
            <br />on the browser to the left, or press <code>File…</code> to pick one.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="session">
      <Head />
      <div className="session-body">
        {torrents.map(t => (
          <div
            key={t.infoHash}
            className={`trow${selected === t.infoHash ? ' selected' : ''}${t.paused ? ' paused' : ''}`}
            onClick={() => onSelect(t.infoHash)}
            onDoubleClick={() => onReveal(t.infoHash)}
          >
            <i className="stripe" style={{ background: clipColor(t.infoHash) }} />

            <div className="cell tname">
              <span className="txt" title={t.name}>{t.name}</span>
            </div>

            <div className="cell"><Meter t={t} /></div>

            <div className="cell r">{t.paused ? '—' : speed(t.downloadSpeed)}</div>
            <div className="cell r">{t.paused ? '—' : speed(t.uploadSpeed)}</div>
            <div className="cell r">{t.numPeers}</div>
            <div className="cell r">{t.done ? 'done' : t.paused ? 'paused' : eta(t.timeRemaining)}</div>

            <div className="cell actions" onClick={e => e.stopPropagation()}>
              {t.paused
                ? <button className="btn icon" title="Resume" onClick={() => onResume(t.infoHash)}>▶</button>
                : <button className="btn icon" title="Pause" onClick={() => onPause(t.infoHash)}>❚❚</button>}
              <button className="btn icon" title="Show in Finder" onClick={() => onReveal(t.infoHash)}>◎</button>
              <button className="btn icon danger" title="Remove" onClick={() => onRemove(t)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Head () {
  return (
    <div className="session-head">
      <i />
      <span className="label">Torrent</span>
      <span className="label">Progress</span>
      <span className="label r">Down</span>
      <span className="label r">Up</span>
      <span className="label r">Peers</span>
      <span className="label r">ETA</span>
      <span className="label r">Actions</span>
    </div>
  )
}

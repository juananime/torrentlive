import { bytes, pct, kindOf } from '../lib/format.js'
import Player from './Player.jsx'
import { revealLabel } from '../lib/platform.js'

/**
 * Live's bottom detail view: everything about the currently selected item.
 * Here that is the torrent's file list plus the streaming preview.
 */
export default function DetailView ({
  torrent, playing, onPlay, onClosePlayer, onReveal, collapsed, onToggle,
  server, onCopyLink, onToast
}) {
  if (collapsed) {
    return (
      <section className="detail collapsed">
        <div className="detail-head">
          <span className="detail-title">{torrent ? torrent.name : 'Detail View'}</span>
          <span className="spacer" />
          <button className="btn icon" title="Expand" onClick={onToggle}>▴</button>
        </div>
      </section>
    )
  }

  return (
    <section className="detail">
      <div className="detail-head">
        <span className="detail-title">
          {torrent ? torrent.name : 'Detail View — no torrent selected'}
        </span>
        {torrent && (
          <span className="label mono">
            {torrent.files.length} files · {bytes(torrent.length)} · {pct(torrent.progress)}
          </span>
        )}
        <span className="spacer" />
        {torrent && (
          <button className="btn" onClick={() => onReveal(torrent.infoHash)}>{revealLabel()}</button>
        )}
        <button className="btn icon" title="Collapse" onClick={onToggle}>▾</button>
      </div>

      <div className={`detail-body${playing ? '' : ' noplayer'}`}>
        <div className="filelist">
          {!torrent && (
            <div className="empty" style={{ padding: '34px 20px' }}>
              <p>Select a torrent above to inspect its files.</p>
            </div>
          )}

          {torrent && !torrent.files.length && (
            <div className="empty" style={{ padding: '34px 20px' }}>
              <p>Waiting for metadata from peers…</p>
            </div>
          )}

          {torrent?.files.map(f => (
            <div
              key={f.index}
              className={`frow${playing?.index === f.index && playing?.infoHash === torrent.infoHash ? ' playing' : ''}`}
              onClick={() => f.streamable && onPlay(torrent.infoHash, f)}
              onDoubleClick={() => onReveal(torrent.infoHash, f.index)}
              title={f.streamable ? 'Click to preview' : f.path}
            >
              <span className="fname">
                <i className="kind">{kindOf(f.mime)}</i>
                {f.name}
              </span>
              <div className="minimeter" title={pct(f.progress)}>
                <div className="fill" style={{ width: `${Math.min(100, f.progress * 100)}%` }} />
              </div>
              {/* Rendered as an empty cell when there is nothing to share, so
                  the grid columns stay aligned down the whole list. */}
              {f.streamable ? (
                <button
                  className="btn icon linkbtn"
                  title={server?.lan ? 'Copy LAN stream link' : 'Copy local stream link'}
                  // The row itself starts playback; the button must not.
                  onClick={e => { e.stopPropagation(); onCopyLink(torrent.infoHash, f.index) }}
                >⧉</button>
              ) : <span />}
              <span className="r">{pct(f.progress)}</span>
              <span className="r">{bytes(f.length)}</span>
            </div>
          ))}
        </div>

        {playing && (
          <Player
            file={playing}
            server={server}
            onToast={onToast}
            onClose={onClosePlayer}
          />
        )}
      </div>
    </section>
  )
}

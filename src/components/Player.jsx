import { useEffect, useRef } from 'react'

/**
 * Plays a file straight off the main process's loopback range server, so
 * playback starts before the torrent has finished and seeking pulls the
 * pieces it needs.
 */
export default function Player ({ file, onClose }) {
  const ref = useRef(null)

  // Swapping files must reload the element, otherwise the old buffer plays on.
  useEffect(() => {
    const el = ref.current
    if (el && file) {
      el.load()
      el.play().catch(() => { /* autoplay may be refused; user can press play */ })
    }
  }, [file?.url])

  if (!file) {
    return (
      <aside className="player">
        <div className="player-stage">
          <div className="player-idle">
            Select a video, audio or image file
            <br />in the list to preview it here.
            <br /><br />Playback streams while downloading.
          </div>
        </div>
      </aside>
    )
  }

  const kind = file.mime.split('/')[0]

  return (
    <aside className="player">
      <div className="player-stage">
        {kind === 'video' && (
          <video ref={ref} src={file.url} controls playsInline />
        )}
        {kind === 'audio' && (
          <audio ref={ref} src={file.url} controls />
        )}
        {kind === 'image' && (
          <img src={file.url} alt={file.name} />
        )}
      </div>
      <div className="player-foot">
        <span className="nm" title={file.name}>{file.name}</span>
        <button className="btn icon" style={{ marginLeft: 'auto' }} title="Close" onClick={onClose}>✕</button>
      </div>
    </aside>
  )
}

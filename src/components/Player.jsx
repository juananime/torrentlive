import { useEffect, useMemo, useRef, useState } from 'react'

const LANGS = [
  ['en', 'English'], ['es', 'Spanish'], ['pt-br', 'Portuguese (BR)'], ['fr', 'French'],
  ['de', 'German'], ['it', 'Italian'], ['nl', 'Dutch'], ['pl', 'Polish'],
  ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['zh-cn', 'Chinese'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['sv', 'Swedish'], ['cs', 'Czech']
]

/**
 * Plays a file straight off the main process's loopback range server, so
 * playback starts before the torrent has finished and seeking pulls the
 * pieces it needs.
 *
 * Subtitles come from three places and are presented as one list: sibling
 * .srt files in the torrent, tracks muxed into the container, and results
 * from the OpenSubtitles finder. All three end up as <track> elements, so
 * switching between them is the same operation.
 */
export default function Player ({ file, server, onToast, onClose }) {
  const ref = useRef(null)
  const [tracks, setTracks] = useState([])
  const [canFind, setCanFind] = useState(false)
  const [active, setActive] = useState('off')
  const [lang, setLang] = useState('en')
  const [finding, setFinding] = useState(false)

  const base = server?.port ? `http://127.0.0.1:${server.port}` : null
  const key = file ? `${file.infoHash}/${file.index}` : null

  // Swapping files must reload the element, otherwise the old buffer plays on.
  useEffect(() => {
    const el = ref.current
    if (el && file) {
      el.load()
      el.play().catch(() => { /* autoplay may be refused; user can press play */ })
    }
  }, [file?.url])

  // What subtitles exist for this file, before anyone goes looking online.
  useEffect(() => {
    setTracks([])
    setActive('off')
    if (!key || !base || !file?.mime?.startsWith('video/')) return
    let cancelled = false
    fetch(`${base}/subtracks/${key}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled || d.error) return
        setTracks(d.tracks || [])
        setCanFind(!!d.canFind)
      })
      .catch(() => { /* the panel simply stays empty */ })
    return () => { cancelled = true }
  }, [key, base, file?.mime])

  // One track showing at a time; the rest disabled so captions never stack.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    for (const t of el.textTracks) t.mode = 'disabled'
    if (active === 'off') return
    const i = tracks.findIndex(t => t.id === active)
    if (i >= 0 && el.textTracks[i]) el.textTracks[i].mode = 'showing'
  }, [active, tracks, file?.url])

  const find = async () => {
    if (!key || !base) return
    setFinding(true)
    try {
      const r = await fetch(`${base}/subfinder/${key}?lang=${encodeURIComponent(lang)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `search failed (${r.status})`)
      const found = (d.results || []).slice(0, 25).map(x => ({
        id: `found:${x.fileId}`,
        label: `${x.name}${x.exact ? '  ·  hash match' : ''}`,
        lang: x.lang,
        src: `${base}/subfetch/${x.fileId}`
      }))
      if (!found.length) { onToast('No subtitles found for that language'); return }
      // Replace previous results rather than piling them up across searches.
      setTracks(t => [...t.filter(x => !x.id.startsWith('found:')), ...found])
      onToast(`${found.length} subtitle${found.length > 1 ? 's' : ''} found${d.hash ? ' — hash matches first' : ''}`)
    } catch (e) {
      onToast(e.message)
    } finally {
      setFinding(false)
    }
  }

  const kind = useMemo(() => file?.mime.split('/')[0], [file?.mime])

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

  return (
    <aside className="player">
      <div className="player-stage">
        {kind === 'video' && (
          <video ref={ref} src={file.url} controls playsInline crossOrigin="anonymous">
            {tracks.map(t => (
              <track key={t.id} kind="subtitles" label={t.label} srcLang={t.lang || ''} src={t.src} />
            ))}
          </video>
        )}
        {kind === 'audio' && (
          <audio ref={ref} src={file.url} controls />
        )}
        {kind === 'image' && (
          <img src={file.url} alt={file.name} />
        )}
      </div>

      {kind === 'video' && (
        <div className="player-subs">
          <span className="label">Subs</span>
          <select
            className="input"
            value={active}
            onChange={e => setActive(e.target.value)}
            disabled={!tracks.length}
          >
            <option value="off">{tracks.length ? 'Off' : 'None available'}</option>
            {tracks.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <select className="input" value={lang} onChange={e => setLang(e.target.value)}>
            {LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
          <button
            className="btn"
            onClick={find}
            disabled={finding}
            title={canFind
              ? 'Search OpenSubtitles by content hash'
              : 'Add an OpenSubtitles API key in the sidebar first'}
          >
            {finding ? 'Searching…' : 'Find…'}
          </button>
        </div>
      )}

      <div className="player-foot">
        <span className="nm" title={file.name}>{file.name}</span>
        <button className="btn icon" style={{ marginLeft: 'auto' }} title="Close" onClick={onClose}>✕</button>
      </div>
    </aside>
  )
}

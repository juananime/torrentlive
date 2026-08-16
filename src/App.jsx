import { useCallback, useEffect, useMemo, useState } from 'react'
import ControlBar from './components/ControlBar.jsx'
import Browser from './components/Browser.jsx'
import SessionView from './components/SessionView.jsx'
import DetailView from './components/DetailView.jsx'

const EMPTY_TOTALS = { downloadSpeed: 0, uploadSpeed: 0, peers: 0, ratio: 0, torrents: 0, progress: 0 }

export default function App () {
  const [torrents, setTorrents] = useState([])
  const [totals, setTotals] = useState(EMPTY_TOTALS)
  const [info, setInfo] = useState(null)
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState(null)
  const [playing, setPlaying] = useState(null)
  const [collapsed, setCollapsed] = useState(false)
  const [toasts, setToasts] = useState([])

  const toast = useCallback(message => {
    const id = Math.random().toString(36).slice(2)
    setToasts(t => [...t, { id, message }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000)
  }, [])

  useEffect(() => {
    window.wt.info().then(setInfo).catch(() => {})

    const offState = window.wt.onState(({ torrents, totals }) => {
      setTorrents(torrents)
      setTotals(totals)
    })
    const offError = window.wt.onError(({ message }) => toast(message))

    return () => { offState(); offError() }
  }, [toast])

  // Keep the selection pointing at something that still exists.
  useEffect(() => {
    if (selected && !torrents.some(t => t.infoHash === selected)) {
      setSelected(torrents[0]?.infoHash ?? null)
    }
    if (!selected && torrents.length) setSelected(torrents[0].infoHash)
  }, [torrents, selected])

  // Main only serialises the file list of the selected torrent, so it needs to
  // know what is selected.
  useEffect(() => {
    window.wt.focus(selected ?? null).catch(() => {})
  }, [selected])

  const counts = useMemo(() => ({
    all: torrents.length,
    downloading: torrents.filter(t => !t.done && !t.paused).length,
    seeding: torrents.filter(t => t.done && !t.paused).length,
    completed: torrents.filter(t => t.done).length,
    paused: torrents.filter(t => t.paused).length
  }), [torrents])

  const visible = useMemo(() => {
    switch (filter) {
      case 'downloading': return torrents.filter(t => !t.done && !t.paused)
      case 'seeding': return torrents.filter(t => t.done && !t.paused)
      case 'completed': return torrents.filter(t => t.done)
      case 'paused': return torrents.filter(t => t.paused)
      default: return torrents
    }
  }, [torrents, filter])

  const current = torrents.find(t => t.infoHash === selected) || null

  // The player holds a file snapshot, so refresh it from the live state to
  // keep per-file progress current without restarting playback.
  const livePlaying = useMemo(() => {
    if (!playing) return null
    const t = torrents.find(x => x.infoHash === playing.infoHash)
    const f = t?.files[playing.index]
    return f ? { ...f, infoHash: playing.infoHash } : null
  }, [playing, torrents])

  const add = useCallback(async source => {
    try { await window.wt.add(source) } catch (e) { toast(e.message) }
  }, [toast])

  const onDrop = useCallback(async items => {
    for (const item of items) {
      try { await window.wt.add(item) } catch (e) { toast(e.message) }
    }
  }, [toast])

  const remove = useCallback(async t => {
    const deleteFiles = window.confirm(
      `Remove "${t.name}" from the session?\n\nPress OK to also delete the downloaded files, or Cancel to keep them on disk.`
    )
    try {
      await window.wt.remove(t.infoHash, deleteFiles)
      if (playing?.infoHash === t.infoHash) setPlaying(null)
    } catch (e) { toast(e.message) }
  }, [playing, toast])

  const chooseFolder = useCallback(async () => {
    const next = await window.wt.chooseFolder()
    setInfo(i => (i ? { ...i, downloadPath: next.downloadPath } : i))
  }, [])

  return (
    <div className="app">
      <ControlBar
        totals={totals}
        info={info}
        onAdd={add}
        onAddFile={() => window.wt.addFile().catch(e => toast(e.message))}
      />

      <div className="main">
        <Browser
          filter={filter}
          onFilter={setFilter}
          counts={counts}
          info={info}
          onDrop={onDrop}
          onChooseFolder={chooseFolder}
        />
        <SessionView
          torrents={visible}
          selected={selected}
          onSelect={setSelected}
          onPause={h => window.wt.pause(h)}
          onResume={h => window.wt.resume(h)}
          onRemove={remove}
          onReveal={(h, i) => window.wt.reveal(h, i)}
        />
      </div>

      <DetailView
        torrent={current}
        playing={livePlaying}
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        onPlay={(infoHash, file) => setPlaying({ infoHash, index: file.index })}
        onClosePlayer={() => setPlaying(null)}
        onReveal={(h, i) => window.wt.reveal(h, i)}
      />

      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map(t => <div key={t.id} className="toast">{t.message}</div>)}
        </div>
      )}
    </div>
  )
}

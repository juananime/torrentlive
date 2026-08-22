import { useEffect, useState } from 'react'

/**
 * Credentials for the subtitle finder.
 *
 * The key itself is write-only from here: the main process stores it and
 * hands back only a fingerprint, so it never sits in renderer state where a
 * stray log or devtools snapshot would expose it.
 */
export default function SubtitleSettings ({ onToast }) {
  const [cfg, setCfg] = useState(null)
  const [open, setOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.wt.getSubtitleConfig().then(c => { setCfg(c); setUsername(c.username || '') })
  }, [])

  const save = async () => {
    setBusy(true)
    try {
      const next = await window.wt.setSubtitleConfig({
        // Blank fields mean "unchanged" for the key and password, which are
        // never displayed back and so cannot be re-typed from the UI.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        username,
        ...(password ? { password } : {})
      })
      setCfg(next)
      setApiKey('')
      setPassword('')
      onToast('Subtitle finder saved')
    } catch (e) { onToast(e.message) } finally { setBusy(false) }
  }

  const test = async () => {
    setBusy(true)
    try {
      const r = await window.wt.testSubtitleConfig()
      onToast(`OpenSubtitles reachable — ${r.results} results for a test query`)
    } catch (e) { onToast(`Test failed: ${e.message}`) } finally { setBusy(false) }
  }

  const clear = async () => {
    setBusy(true)
    try {
      setCfg(await window.wt.setSubtitleConfig({ apiKey: null, username: null, password: null }))
      setUsername('')
      onToast('Subtitle finder credentials cleared')
    } catch (e) { onToast(e.message) } finally { setBusy(false) }
  }

  if (!cfg) return null

  return (
    <>
      <span className="label" style={{ marginTop: 3 }}>Subtitle Finder</span>
      <div className={`serverline${cfg.configured ? ' live' : ''}`}>
        <i className="dot" />
        <span className="mono">{cfg.configured ? `key ${cfg.keyHint}` : 'no API key'}</span>
      </div>

      {!open && (
        <button className="btn" onClick={() => setOpen(true)}>
          {cfg.configured ? 'Change credentials…' : 'Add API key…'}
        </button>
      )}

      {open && (
        <div className="subcfg">
          <input
            className="input" type="password" spellCheck={false}
            placeholder={cfg.configured ? 'New API key (blank = keep)' : 'OpenSubtitles API key'}
            value={apiKey} onChange={e => setApiKey(e.target.value)}
          />
          <input
            className="input" spellCheck={false} placeholder="Username (optional)"
            value={username} onChange={e => setUsername(e.target.value)}
          />
          <input
            className="input" type="password" spellCheck={false}
            placeholder={cfg.hasPassword ? 'Password (blank = keep)' : 'Password (optional)'}
            value={password} onChange={e => setPassword(e.target.value)}
          />
          <div className="subcfg-row">
            <button className="btn primary" disabled={busy} onClick={save}>Save</button>
            <button className="btn" disabled={busy || !cfg.configured} onClick={test}>Test</button>
            <button className="btn" onClick={() => setOpen(false)}>Close</button>
          </div>
          {cfg.configured && (
            <button className="btn danger" disabled={busy} onClick={clear}>Clear credentials</button>
          )}
          <div className="pathline">
            A free key comes from opensubtitles.com → API consumers. Signing in
            as well is optional and raises the daily download limit.
          </div>
        </div>
      )}
    </>
  )
}

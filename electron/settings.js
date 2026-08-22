// ---------------------------------------------------------------------------
// Persisted settings.
//
// One small JSON file in the app's userData directory. The only things that
// need to survive a restart are the download folder and the OpenSubtitles
// credentials — nobody wants to paste an API key twice.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = {
  downloadPath: null,
  openSubtitles: { apiKey: '', username: '', password: '' }
}

let file = null
let cache = { ...DEFAULTS }

/**
 * `legacyDirs` are userData directories the app used under previous names.
 * Electron derives that path from the package name, so renaming the product
 * silently moves it — and a saved API key would look like it had vanished.
 */
export function init (userDataDir, legacyDirs = []) {
  file = path.join(userDataDir, 'settings.json')
  const source = [file, ...legacyDirs.map(d => path.join(d, 'settings.json'))]
    .find(f => { try { return fs.existsSync(f) } catch { return false } }) || file
  try {
    const raw = JSON.parse(fs.readFileSync(source, 'utf8'))
    cache = {
      ...DEFAULTS,
      ...raw,
      openSubtitles: { ...DEFAULTS.openSubtitles, ...(raw.openSubtitles || {}) }
    }
    // Adopted from an older location: write it forward so this is the last
    // time we go looking.
    if (source !== file) patch({})
  } catch {
    // Absent or corrupt: defaults are correct and the next save rewrites it.
  }
  return cache
}

export const get = () => cache

export function patch (changes) {
  cache = {
    ...cache,
    ...changes,
    openSubtitles: { ...cache.openSubtitles, ...(changes.openSubtitles || {}) }
  }
  try {
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 })
  } catch (e) {
    console.error('[settings] could not save:', e.message)
  }
  return cache
}

/**
 * What the renderer is allowed to see. The key is reduced to a fingerprint and
 * the password to a boolean — enough for the UI to show "configured", without
 * the secrets crossing the IPC boundary or landing in a state tick.
 */
export function redacted () {
  const os = cache.openSubtitles
  return {
    configured: !!os.apiKey,
    keyHint: os.apiKey ? `••••${os.apiKey.slice(-4)}` : '',
    username: os.username || '',
    hasPassword: !!os.password
  }
}

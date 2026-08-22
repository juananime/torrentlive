// CommonJS on purpose: sandboxed preload scripts cannot be ES modules, and the
// project is "type": "module", so the .cjs extension is what keeps this valid.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('wt', {
  info: () => ipcRenderer.invoke('app:info'),

  /**
   * Electron 32 removed the non-standard File.path property, so the only way
   * to turn a dropped File into a real filesystem path is webUtils, and it has
   * to be called here in the preload rather than in the sandboxed renderer.
   */
  pathForFile: file => {
    try { return webUtils.getPathForFile(file) } catch { return null }
  },

  add: (source, savePath) => ipcRenderer.invoke('torrent:add', { source, savePath }),
  addFile: () => ipcRenderer.invoke('torrent:addFile'),
  pause: infoHash => ipcRenderer.invoke('torrent:pause', infoHash),
  resume: infoHash => ipcRenderer.invoke('torrent:resume', infoHash),
  remove: (infoHash, deleteFiles) => ipcRenderer.invoke('torrent:remove', { infoHash, deleteFiles }),
  reveal: (infoHash, fileIndex) => ipcRenderer.invoke('torrent:reveal', { infoHash, fileIndex }),
  chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),

  /** Subtitle finder credentials. The key itself never comes back out. */
  getSubtitleConfig: () => ipcRenderer.invoke('subtitles:getConfig'),
  setSubtitleConfig: cfg => ipcRenderer.invoke('subtitles:setConfig', cfg),
  testSubtitleConfig: () => ipcRenderer.invoke('subtitles:testConfig'),

  /** LAN video server: rebind the stream server on/off the network. */
  setLanSharing: enabled => ipcRenderer.invoke('server:setLan', enabled),
  copyLink: (infoHash, fileIndex) => ipcRenderer.invoke('server:copyLink', { infoHash, fileIndex }),
  copyWebLink: () => ipcRenderer.invoke('server:copyWebLink'),

  /** Subscribe to the 500ms state tick. Returns an unsubscribe function. */
  onState: cb => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('torrents:state', handler)
    return () => ipcRenderer.removeListener('torrents:state', handler)
  },

  onError: cb => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('torrents:error', handler)
    return () => ipcRenderer.removeListener('torrents:error', handler)
  }
})

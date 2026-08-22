/**
 * Platform-specific wording.
 *
 * Set from `app:info` once the renderer starts; "Finder" is meaningless on
 * Windows and Linux, and shipping it there reads like an unported app.
 */
let platform = 'darwin'

export const setPlatform = p => { platform = p || 'darwin' }

export const revealLabel = () => (
  platform === 'win32' ? 'Show in Explorer'
    : platform === 'linux' ? 'Show in folder'
      : 'Show in Finder'
)

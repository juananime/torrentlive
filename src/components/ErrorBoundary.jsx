import { Component } from 'react'

/**
 * Stops one bad row from taking down the whole window.
 *
 * React unmounts the entire tree when a render throws, which in this app
 * leaves nothing but the near-black page background — indistinguishable from
 * a crashed process. A single torrent with an unexpected shape should not do
 * that, so this catches the error, shows it, and offers a way back.
 */
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError (error) {
    return { error }
  }

  componentDidCatch (error, info) {
    // Keep it in the console too, so `npm run smoke` still sees a failure.
    console.error('render error:', error, info?.componentStack)
    window.wt?.reportError?.(
      `render: ${error?.message}\n${(info?.componentStack || '').slice(0, 800)}`
    )
  }

  render () {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <h3>Interface error</h3>
        <p className="msg">{String(error?.message || error)}</p>
        <p>
          The torrent session is still running in the background — only the
          display stopped. Reloading rebuilds it from live state.
        </p>
        <button className="btn primary" onClick={() => window.location.reload()}>
          Reload interface
        </button>
      </div>
    )
  }
}

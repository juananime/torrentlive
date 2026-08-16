import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import './styles.css'

// Dropping a file anywhere outside the browser panel would otherwise make
// Electron navigate away from the app.
window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('drop', e => e.preventDefault())

// Anything that escapes React goes to the crash log, so a failure in the field
// leaves a trace instead of just a blank window.
window.addEventListener('error', e => {
  window.wt?.reportError?.(`${e.message} @ ${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', e => {
  window.wt?.reportError?.(`unhandled rejection: ${e.reason?.message || e.reason}`)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

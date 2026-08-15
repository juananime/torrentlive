import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// Dropping a file anywhere outside the browser panel would otherwise make
// Electron navigate away from the app.
window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('drop', e => e.preventDefault())

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import App from './App'
import './styles.css'

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const reloadKey = 'srs-preload-recovery-at'
  const previousReload = Number(sessionStorage.getItem(reloadKey) ?? 0)
  if (Date.now() - previousReload < 15_000) return
  sessionStorage.setItem(reloadKey, String(Date.now()))
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(import.meta.env.VITE_BUILD_ID)}`, {
      updateViaCache: 'none',
    }).then((registration) => registration.update())
  })
}

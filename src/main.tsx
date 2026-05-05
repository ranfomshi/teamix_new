import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'

// Capture beforeinstallprompt immediately — before React mounts.
// The event fires early (once SW is active) and is missed if we
// only listen inside a component useEffect.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
let _installPrompt: BeforeInstallPromptEvent | null = null
console.log('[PWA] main.tsx loaded — listening for beforeinstallprompt')
window.addEventListener('beforeinstallprompt', (e) => {
  console.log('[PWA] beforeinstallprompt fired at module level ✓', e)
  e.preventDefault()
  _installPrompt = e as BeforeInstallPromptEvent
})
export function getInstallPrompt() { return _installPrompt }
export function clearInstallPrompt() { _installPrompt = null }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

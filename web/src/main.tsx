import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/details.css';
import './styles/modals.css';
import './styles/usage.css';
import './styles/stats.css';
import './styles/team.css';
import './styles/call.css';
import './styles/viewer.css';
import './styles/voice.css';
import './styles/features.css';
import './styles/sheet.css';
import './styles/sessions.css';
import './styles/notify.css';
import './styles/screenshots.css';
import './styles/workfx.css';
import './styles/motion.css';

if (/Electron\//.test(navigator.userAgent)) {
  document.documentElement.dataset.desktopWindow = 'true';
  // Page zoom (View → Zoom In/Out). In the Mac window outerWidth is in screen points and innerWidth in page
  // pixels, so their ratio is the zoom (checked in Electron: 0.9 → 1000/1111). The CSS sizes the space around the
  // macOS window buttons in screen points with it (shell.css), so zooming never crowds or shifts them.
  const zoom = () => {
    const z = outerWidth > 0 && innerWidth > 0 ? outerWidth / innerWidth : 1;
    document.documentElement.style.setProperty('--window-zoom', String(Math.min(5, Math.max(0.25, Math.round(z * 100) / 100))));
  };
  zoom();
  window.addEventListener('resize', zoom);
}

// Panel widths animate when you open or close them, but follow the window instantly while
// it is being resized; otherwise the sidebar and details panel lag behind the window edge.
{
  let settle = 0;
  window.addEventListener('resize', () => {
    document.documentElement.dataset.resizing = '';
    clearTimeout(settle);
    settle = window.setTimeout(() => { delete document.documentElement.dataset.resizing; }, 160);
  }, { passive: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

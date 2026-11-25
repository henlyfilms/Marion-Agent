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
import './styles/team.css';
import './styles/call.css';
import './styles/viewer.css';
import './styles/voice.css';
import './styles/features.css';
import './styles/sheet.css';
import './styles/sessions.css';
import './styles/notify.css';
import './styles/motion.css';

if (/Electron\//.test(navigator.userAgent)) document.documentElement.dataset.desktopWindow = 'true';

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

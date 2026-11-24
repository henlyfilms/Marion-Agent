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

if (/Electron\//.test(navigator.userAgent)) document.documentElement.dataset.desktopWindow = 'true';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

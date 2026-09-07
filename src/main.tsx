import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Two weights only (regular + bold) to keep the bundle small — the 500/medium
// weight falls back to 400, which is a barely-perceptible difference.
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

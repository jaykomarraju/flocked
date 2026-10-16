import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { detectMiniApp, type MiniApp } from './auth/miniapp';
import { installTheme } from './theme';
import './theme/base.css';

installTheme();

/** The mini app context, if the page runs inside a Farcaster or Base client (never blocks for long). */
async function miniAppContext(): Promise<MiniApp | null> {
  try {
    return await Promise.race([
      detectMiniApp(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
  } catch {
    return null;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
const miniApp = await miniAppContext();
const miniAppWallet = miniApp ? await miniApp.ethereumProvider().catch(() => undefined) : undefined;
createRoot(root).render(
  <StrictMode>
    <App miniApp={miniApp} miniAppWallet={miniAppWallet} />
  </StrictMode>,
);

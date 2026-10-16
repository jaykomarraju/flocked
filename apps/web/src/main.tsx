import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installTheme } from './theme';
import './theme/base.css';

installTheme();

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

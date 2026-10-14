/**
 * Web entrypoint. Owner: Lead.
 *
 * The bundle is produced by Rollup + TypeScript (no Vite/esbuild) and served by
 * the Fastify server at `/assets/app.js`.
 */
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from './components/ui';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <BrowserRouter>
    <ToastProvider>
      <App />
    </ToastProvider>
  </BrowserRouter>,
);

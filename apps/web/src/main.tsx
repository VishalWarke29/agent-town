// Configures zod to skip its `new Function` eval probe before any other module gets a chance to
// trigger it (SP-4): under the service's real CSP (no unsafe-eval) that probe's caught throw still
// reaches the page as a securitypolicyviolation on every load. Must stay the first import in this file.
import './zod-jitless';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppBoundary } from './AppBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><AppBoundary><App /></AppBoundary></StrictMode>);

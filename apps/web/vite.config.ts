import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export function developmentServerOptions(env: NodeJS.ProcessEnv = process.env) {
  const readPort = (name: string, fallback: number) => {
    const raw = env[name];
    const port = raw === undefined ? fallback : /^\d{4,5}$/u.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${name} must be an integer between 1024 and 65535.`);
    return port;
  };
  const servicePort = readPort('AGENT_TOWN_PORT', 4310), webPort = readPort('AGENT_TOWN_WEB_PORT', 5173);
  if (servicePort === webPort) throw new Error('Development service and web ports must be different.');
  return {
    host: '127.0.0.1', port: webPort, strictPort: true,
    // HMR shares the strict web port; API requests preserve browser Host/Origin for service validation.
    ws: { host: '127.0.0.1', clientPort: webPort },
    proxy: { '/api': { target: `http://127.0.0.1:${servicePort}`, changeOrigin: false } },
  };
}

export default defineConfig(() => ({
  plugins: [react()],
  server: developmentServerOptions(),
  build: { chunkSizeWarningLimit: 1100 },
}));

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 40000,
  expect: { timeout: 12000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4311',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    channel: process.env.AGENT_TOWN_BROWSER ?? 'msedge',
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'node apps/service/dist/index.js',
    url: 'http://127.0.0.1:4311/api/v1/health',
    reuseExistingServer: false,
    timeout: 20000,
    env: { NODE_ENV: 'production', AGENT_TOWN_MODE: 'development', AGENT_TOWN_PORT: '4311', AGENT_TOWN_DATA_DIR: `.data/browser-tests/${Date.now()}` },
  },
});

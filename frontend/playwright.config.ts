import { defineConfig, devices } from '@playwright/test';

// An opt-in, disposable local backend and approved test account are required.
// Never reuse an arbitrary server that happens to listen on the test port.
const isolatedBackend = process.env.P18_BROWSER_TEST_ISOLATED === '1' &&
  process.env.LOCAL_BACKEND_URL === 'http://127.0.0.1:3402' &&
  !!process.env.LOCAL_BACKEND_FRONTEND_TOKEN &&
  !!process.env.P18_BROWSER_TEST_EMAIL && !!process.env.P18_BROWSER_TEST_PASSWORD;

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 12'] },
    },
  ],
  webServer: isolatedBackend ? {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3000',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    timeout: 120000,
    env: { PERSISTENCE_AUTHORITY: 'local_postgres' },
  } : undefined,
});

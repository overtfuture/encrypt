import { defineConfig, devices } from '@playwright/test';

const baseURL = `http://localhost:4173${process.env.PAGES_BASE_PATH || '/'}`;

export default defineConfig({
  testDir: './tests',
  testMatch: [
    'message-content.spec.ts',
    'pages.spec.ts',
    'timelock.spec.ts',
    'timelock.live.spec.ts',
  ],
  outputDir: './test-results-production',
  fullyParallel: true,
  use: {
    baseURL,
    channel: 'chrome',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'production-desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'production-mobile',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: baseURL,
    reuseExistingServer: false,
  },
});

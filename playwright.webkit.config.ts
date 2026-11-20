import { defineConfig, devices } from '@playwright/test';
import production from './playwright.production.config';

// Real WebKit/Web Crypto; WebAuthn provider calls remain mocked by the tests.
export default defineConfig({
  ...production,
  outputDir: './test-results-webkit',
  use: { ...production.use, channel: undefined },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], channel: undefined },
    },
  ],
});

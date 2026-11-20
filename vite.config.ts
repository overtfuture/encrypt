import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { offlineShell } from './scripts/offline.ts';

export default defineConfig({
  base: process.env.PAGES_BASE_PATH || '/',
  plugins: [solid(), tailwindcss(), offlineShell()],
  server: {
    watch: {
      ignored: [
        '**/test-results/**',
        '**/test-results-production/**',
        '**/playwright-report/**',
      ],
    },
  },
  resolve: {
    alias: [
      {
        find: /^crypto$/,
        replacement: fileURLToPath(
          new URL('./src/lib/browser-crypto.ts', import.meta.url),
        ),
      },
    ],
  },
  build: { target: 'es2022' },
});

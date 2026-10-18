import { test, expect } from '@playwright/test';
import { fixtureDrand } from './drand-fixture';

test('creates a link that reveals a Unicode message without a PIN', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Your message')
    .fill('A tiny surprise 🌿\nSee you soon.');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  const link = await page.getByLabel('Share link').inputValue();
  expect(link).toContain('/#');
  await expect(
    page.getByRole('img', { name: 'Message QR code' }),
  ).toBeVisible();
  await page.goto(link);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'A tiny surprise 🌿\nSee you soon.',
  );
  await expect(
    page.getByRole('heading', { name: 'Message decrypted' }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('requires a PIN and recovers from a wrong attempt', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your message').fill('Just for you.');
  await page.getByRole('switch', { name: 'Require a PIN' }).click();
  await page.getByLabel('Choose a PIN').fill('024680');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  await page.goto(await page.getByLabel('Share link').inputValue());
  await page.getByLabel('Enter PIN').fill('111111');
  await page.getByRole('button', { name: 'Decrypt message' }).click();
  await expect(page.getByRole('alert')).toContainText('PIN');
  await page.getByLabel('Enter PIN').fill('024680');
  await page.getByRole('button', { name: 'Decrypt message' }).click();
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'Just for you.',
  );
});

test('counts down and automatically reveals when the clock reaches the date', async ({
  page,
}) => {
  await fixtureDrand(page);
  await page.clock.install({ time: new Date('2023-08-23T15:58:00Z') });
  await page.goto('/');
  await page.getByLabel('Your message').fill('The wait is over.');
  await page.getByRole('switch', { name: 'Set an opening time' }).click();
  await page.getByLabel('Opening date and time').fill('2023-08-23T15:59');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  await page.goto(await page.getByLabel('Share link').inputValue());
  await expect(
    page.getByRole('heading', { name: 'Message locked' }),
  ).toBeVisible();
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
  await page.clock.fastForward(61_000);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'The wait is over.',
  );
});

test('can download a QR and open it from an image upload', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your message').fill('A message in a picture.');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Save QR code' }).click();
  const file = await download;
  await page
    .getByRole('button', { name: 'Open a message', exact: true })
    .click();
  await page.getByLabel('Upload QR image').setInputFiles((await file.path())!);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'A message in a picture.',
  );
});

test('keeps links available when a message exceeds QR capacity', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Your message')
    .fill('Long notes are links too. '.repeat(250));
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  const link = await page.getByLabel('Share link').inputValue();
  await expect(
    page.getByText('Too large for a QR code. Share the link instead.'),
  ).toBeVisible();
  await page.goto(link);
  await expect(page.getByTestId('revealed-message')).toContainText(
    'Long notes are links too.',
  );
});

test('reports invalid payloads and keeps the mobile layout within the viewport', async ({
  page,
}) => {
  await page.goto('/#not-a-message');
  await expect(page.getByRole('alert')).toContainText('valid');
  await page.getByLabel('Link or payload').fill('this is not a message');
  await page.getByRole('button', { name: 'Open message', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBe(true);
});

test('opens a pasted link and keeps the PIN prompt behind the countdown', async ({
  page,
}) => {
  await fixtureDrand(page);
  await page.clock.install({ time: new Date('2023-08-23T15:58:00Z') });
  await page.goto('/');
  await page.getByLabel('Your message').fill('A surprise with two conditions.');
  await page.getByRole('switch', { name: 'Set an opening time' }).click();
  await page.getByLabel('Opening date and time').fill('2023-08-23T15:59');
  await page.getByRole('switch', { name: 'Require a PIN' }).click();
  await page.getByLabel('Choose a PIN').fill('123456');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  const link = await page.getByLabel('Share link').inputValue();
  await page
    .getByRole('button', { name: 'Open a message', exact: true })
    .click();
  await page.getByLabel('Link or payload').fill(link);
  await page.getByRole('button', { name: 'Open message', exact: true }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByLabel('Enter PIN')).toHaveCount(0);
  await page.clock.fastForward(61_000);
  await expect(page.getByLabel('Enter PIN')).toBeVisible();
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
  await page.getByLabel('Enter PIN').fill('123456');
  await page.getByRole('button', { name: 'Decrypt message' }).click();
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'A surprise with two conditions.',
  );
});

test('accepts text as text and never makes a third-party request', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (
      !request.url().startsWith('http://localhost:5173') &&
      !request.url().startsWith('data:')
    )
      external.push(request.url());
  });
  await page.goto('/');
  await page
    .getByLabel('Your message')
    .fill('<img src="https://example.com/pixel" onerror="alert(1)">');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  await page.goto(await page.getByLabel('Share link').inputValue());
  await expect(page.getByTestId('revealed-message')).toHaveText(
    '<img src="https://example.com/pixel" onerror="alert(1)">',
  );
  await expect(page.getByTestId('revealed-message').locator('img')).toHaveCount(
    0,
  );
  expect(external).toEqual([]);
});

test('handles camera permission denial without getting stuck', async ({
  page,
  context,
}) => {
  await context.grantPermissions([]);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open a message', exact: true })
    .click();
  // Explicitly deny a real browser permission, rather than replacing scanner behavior.
  const session = await context.newCDPSession(page);
  await session.send('Browser.setPermission', {
    permission: { name: 'camera' },
    setting: 'denied',
    origin: 'http://localhost:5173',
  });
  await page.getByRole('button', { name: 'Use camera' }).click();
  await expect(page.getByRole('alert')).toContainText('camera');
  await expect(page.getByRole('button', { name: 'Use camera' })).toBeEnabled();
  await page.getByLabel('Link or payload').fill('still usable');
  await expect(
    page.getByRole('button', { name: 'Open message', exact: true }),
  ).toBeEnabled();
});

test('can reopen the same link after resetting and clears the reader when its fragment is removed', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Your message').fill('Open me again.');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  const link = await page.getByLabel('Share link').inputValue();
  await page.goto(link);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'Open me again.',
  );
  await page.getByRole('button', { name: 'Open another message' }).click();
  await expect(page.getByLabel('Link or payload')).toBeVisible();
  await page.evaluate((url) => {
    window.location.href = url;
  }, link);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'Open me again.',
  );
  await page.evaluate(() => {
    window.location.hash = '';
  });
  await expect(page.getByLabel('Link or payload')).toBeVisible();
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
});

test('ignores a camera decode that finishes after the scanner is stopped', async ({
  page,
}) => {
  // The hardware/worker boundary supplies a late completion, like an already-running
  // qr-scanner scanImage call. Assertions exercise the real reader and scanner UI.
  await page.route('**/node_modules/.vite/deps/qr-scanner.js*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `export default class QrScanner {
      constructor(video, callback) {
        window.addEventListener('afterword-test-late-decode', event => callback({ data: event.detail }));
      }
      async start() {}
      destroy() {}
    }`,
    }),
  );
  await page.goto('/');
  await page.getByLabel('Your message').fill('A stale camera message.');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  const link = await page.getByLabel('Share link').inputValue();
  await page
    .getByRole('button', { name: 'Open a message', exact: true })
    .click();
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await page.evaluate(
    (value) =>
      window.dispatchEvent(
        new CustomEvent('afterword-test-late-decode', { detail: value }),
      ),
    link,
  );
  await expect(page.getByLabel('Link or payload')).toBeVisible();
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
});

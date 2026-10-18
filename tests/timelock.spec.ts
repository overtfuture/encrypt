import { test, expect, type Page } from '@playwright/test';
import { fixtureDrand } from './drand-fixture';
import legacy from './fixtures/legacy.json' with { type: 'json' };
import beacons from './fixtures/quicknet.json' with { type: 'json' };

async function timedLink(page: Page) {
  await page.clock.install({ time: new Date('2023-08-23T15:58:00Z') });
  await page.goto('./');
  await page.getByLabel('Your message').fill('Time holds the key.');
  await page.getByRole('switch', { name: 'Set an opening time' }).click();
  await page.getByLabel('Opening date and time').fill('2023-08-23T15:59');
  await page.getByRole('button', { name: 'Seal & share' }).click();
  return page.getByLabel('Share link').inputValue();
}

test('keeps the countdown readable, waits for a verified beacon and retries automatically', async ({
  page,
}) => {
  const drand = await fixtureDrand(page, false);
  const link = await timedLink(page);
  expect(drand.requests).toEqual([]); // Creation uses pinned public parameters locally.
  const payload = JSON.parse(
    Buffer.from(new URL(link).hash.slice(1), 'base64url').toString(),
  );
  expect(payload.u).toBe(Date.parse('2023-08-23T15:59:00Z'));
  expect(payload.v).toBe(2);
  await page.goto(link);
  await expect(page.getByRole('timer')).toBeVisible();
  expect(drand.requests).toEqual([]);
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('status')).toContainText('drand');
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
  drand.available = true;
  await page.clock.fastForward(11_000);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'Time holds the key.',
  );
});

test('can manually retry an unavailable unlock beacon', async ({ page }) => {
  const drand = await fixtureDrand(page, false);
  await page.goto(await timedLink(page));
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('status')).toContainText('drand');
  drand.available = true;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'Time holds the key.',
  );
});

test('advancing the clock cannot reveal a message whose future beacon does not exist', async ({
  page,
}) => {
  await fixtureDrand(page);
  await page.clock.install({ time: new Date('2030-01-01T12:00:00Z') });
  await page.goto('./');
  await page.getByLabel('Your message').fill('No shortcuts through time.');
  await page.getByRole('switch', { name: 'Set an opening time' }).click();
  await page.getByLabel('Opening date and time').fill('2030-01-01T12:01');
  await page.getByRole('button', { name: 'Seal & share' }).click();
  await page.goto(await page.getByLabel('Share link').inputValue());
  await page.clock.fastForward(86_400_000);
  await expect(page.getByRole('status')).toContainText('drand');
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
});

test('labels dated legacy links without upgrading their original security claim', async ({
  page,
}) => {
  await page.goto(`./#${legacy.dated}`);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'A legacy timed note.',
  );
  await expect(
    page.getByText('Legacy message: its countdown can be bypassed.'),
  ).toBeVisible();
});

test('retains the PIN requirement through a beacon outage and a wrong attempt', async ({
  page,
}) => {
  const drand = await fixtureDrand(page, false);
  await timedLink(page);
  await page.getByRole('switch', { name: 'Require a PIN' }).click();
  await page.getByLabel('Choose a PIN').fill('024680');
  await page.getByRole('button', { name: 'Seal & share' }).click();
  await page.goto(await page.getByLabel('Share link').inputValue());
  await page.clock.fastForward(61_000);
  await page.getByLabel('Enter PIN').fill('111111');
  await page.getByRole('button', { name: 'Reveal message' }).click();
  await expect(page.getByRole('status')).toContainText('drand');
  drand.available = true;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('alert')).toContainText('PIN');
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
  await page.getByLabel('Enter PIN').fill('024680');
  await page.getByRole('button', { name: 'Reveal message' }).click();
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'Time holds the key.',
  );
});

test('resetting cancels an unlock request and does not reveal a late response', async ({
  page,
}) => {
  let finish!: () => void;
  const response = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let requests = 0;
  await page.route('https://*.drand.sh/**', async (route) => {
    requests++;
    await response;
    await route
      .fulfill({
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(beacons['992']),
      })
      .catch(() => {});
  });
  const link = await timedLink(page);
  await page.goto(link);
  const request = page.waitForRequest('https://api.drand.sh/**/public/992');
  await page.clock.fastForward(61_000);
  await request;
  await page.getByRole('button', { name: 'Open another message' }).click();
  finish();
  await page.clock.fastForward(61_000);
  await expect(page.getByLabel('Link or payload')).toBeVisible();
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
  expect(requests).toBe(1);
});

test('has its crypto runtime ready before the countdown starts', async ({
  page,
}) => {
  await fixtureDrand(page);
  const link = await timedLink(page);
  await page.goto(link);
  await expect(page.getByRole('timer')).toBeVisible();
  // A deployed asset disappearing (or a local connection dropping) must not
  // require an additional script download at the moment of opening.
  await page.route(`${new URL(link).origin}/**`, (route) =>
    route.request().resourceType() === 'script'
      ? route.abort('internetdisconnected')
      : route.continue(),
  );
  await page.clock.fastForward(61_000);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'Time holds the key.',
  );
});

test('resumes automatic opening after an ahead-of-time clock is corrected', async ({
  page,
}) => {
  const drand = await fixtureDrand(page, false);
  await page.goto(await timedLink(page));
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('status')).toContainText('drand');
  await page.clock.setSystemTime(new Date('2023-08-23T15:58:40Z'));
  await page.clock.fastForward(11_000); // The old retry runs before the corrected deadline.
  drand.available = true;
  await page.clock.fastForward(11_000);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'Time holds the key.',
  );
});

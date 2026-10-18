import { test, expect, type Page } from '@playwright/test';
import { sealMessage } from '../src/lib/payload';
import { fixtureDrand } from './drand-fixture';

async function openText(page: Page, text: string, pin?: string) {
  const encoded = await sealMessage(text, { pin });
  await page.goto(`./#${encoded}`);
}

test('renders Markdown and detects links without loading remote content', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.com/'))
      external.push(request.url());
  });
  await openText(
    page,
    '# Project notes\n\n**Ready** with *details*.\n\n- First item\n- Second item\n\nVisit https://example.com/docs or [read more](https://example.com/more).\n\n![Diagram](https://example.com/diagram.png)\n\n```js\nconst value = 1 < 2;\n```',
  );
  const content = page.getByTestId('revealed-message');
  await expect(
    content.getByRole('heading', { name: 'Project notes' }),
  ).toBeVisible();
  await expect(content.locator('strong')).toHaveText('Ready');
  await expect(content.locator('em')).toHaveText('details');
  await expect(content.getByRole('listitem')).toHaveCount(2);
  const link = content.getByRole('link', {
    name: 'https://example.com/docs',
    exact: true,
  });
  await expect(link).toHaveAttribute('href', 'https://example.com/docs');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(
    content.getByRole('link', { name: 'read more' }),
  ).toHaveAttribute('href', 'https://example.com/more');
  await expect(content.locator('pre code')).toHaveText(
    'const value = 1 < 2;\n',
  );
  await expect(content.locator('img')).toHaveCount(0);
  await expect(
    content.getByRole('link', { name: 'Image: Diagram' }),
  ).toHaveAttribute('href', 'https://example.com/diagram.png');
  expect(external).toEqual([]);
});

test('keeps raw HTML and unsafe Markdown links inert', async ({ page }) => {
  await openText(
    page,
    '<script>window.location="https://example.com/unsafe"</script>\n\n<img src=x onerror=alert(1)>\n\n[Run](javascript:alert(1))\n\n[Data](data:text/html,unsafe)',
  );
  const content = page.getByTestId('revealed-message');
  await expect(content).toContainText('<script>');
  await expect(content.locator('script, img, iframe')).toHaveCount(0);
  await expect(
    content.getByRole('link', { name: 'Run', exact: true }),
  ).toHaveCount(0);
  await expect(
    content.getByRole('link', { name: 'Data', exact: true }),
  ).toHaveCount(0);
  expect(page.url()).toContain('/#');
});

test('redirects a URL-only message after the countdown and correct PIN', async ({
  page,
}) => {
  await fixtureDrand(page);
  await page.clock.install({ time: new Date('2023-08-23T15:58:00Z') });
  const encoded = await sealMessage(
    '  https://example.com/destination?from=message  ',
    {
      pin: '024680',
      unlockAt: Date.parse('2023-08-23T15:59:00Z'),
    },
  );
  const navigations: string[] = [];
  const referrers: (string | undefined)[] = [];
  await page.route('https://example.com/destination?from=message', (route) => {
    navigations.push(route.request().url());
    referrers.push(route.request().headers().referer);
    return route.fulfill({
      contentType: 'text/html',
      body: '<h1>Destination</h1>',
    });
  });
  await page.goto(`./#${encoded}`);
  await expect(page.getByRole('timer')).toBeVisible();
  expect(navigations).toEqual([]);
  await page.clock.fastForward(61_000);
  await expect(page.getByLabel('Enter PIN')).toBeVisible();
  expect(navigations).toEqual([]);
  await page.getByLabel('Enter PIN').fill('111111');
  await page.getByRole('button', { name: 'Decrypt message' }).click();
  await expect(page.getByRole('alert')).toContainText('PIN');
  expect(navigations).toEqual([]);
  await page.getByLabel('Enter PIN').fill('024680');
  await page.getByRole('button', { name: 'Decrypt message' }).click();
  await expect(page).toHaveURL('https://example.com/destination?from=message');
  await expect(
    page.getByRole('heading', { name: 'Destination' }),
  ).toBeVisible();
  expect(navigations).toEqual(['https://example.com/destination?from=message']);
  expect(referrers).toEqual([undefined]);
});

test('redirects a URL-only message without a PIN', async ({ page }) => {
  await page.route('https://example.com/immediate', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Immediate destination</h1>',
    }),
  );
  await openText(page, 'https://example.com/immediate');
  await expect(page).toHaveURL('https://example.com/immediate');
});

test('keeps a URL with surrounding text on the message page', async ({
  page,
}) => {
  await openText(page, 'Read https://example.com/docs for details.');
  await expect(
    page.getByTestId('revealed-message').getByRole('link'),
  ).toHaveAttribute('href', 'https://example.com/docs');
  expect(page.url()).toContain('/#');
});

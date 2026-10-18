import { test, expect } from '@playwright/test';

test('preserves the deployment path in share links and loads the QR worker', async ({
  page,
  baseURL,
}) => {
  const site = new URL(baseURL!);
  const failedAssets: string[] = [];
  const outsideBase: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      url.protocol === site.protocol &&
      url.origin === site.origin &&
      response.status() >= 400
    )
      failedAssets.push(url.pathname);
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.protocol === site.protocol &&
      url.origin === site.origin &&
      !url.pathname.startsWith(site.pathname)
    )
      outsideBase.push(url.pathname);
  });

  await page.goto('./');
  await page.getByLabel('Your message').fill('A message from GitHub Pages.');
  await page.getByRole('button', { name: 'Encrypt & share' }).click();
  const link = await page.getByLabel('Share link').inputValue();
  expect(new URL(link).pathname).toBe(site.pathname);
  expect(new URL(link).origin).toBe(site.origin);

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Save QR code' }).click();
  const qr = await download;
  await page.goto(link);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'A message from GitHub Pages.',
  );
  await page.getByRole('button', { name: 'Open another message' }).click();
  await page.getByLabel('Upload QR image').setInputFiles((await qr.path())!);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'A message from GitHub Pages.',
  );
  expect(failedAssets).toEqual([]);
  expect(outsideBase).toEqual([]);
});

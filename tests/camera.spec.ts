import { test, expect } from '@playwright/test';

// Use Chrome's synthetic video source, never the user's physical camera.
test.use({
  permissions: ['camera'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('stopping the scanner releases its video track', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open a message', exact: true })
    .click();
  await page.getByRole('button', { name: 'Use camera' }).click();
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate(
          (video: HTMLVideoElement) =>
            (video.srcObject as MediaStream | null)?.getVideoTracks()[0]
              ?.readyState,
        ),
    )
    .toBe('live');
  const track = await page
    .locator('video')
    .evaluateHandle(
      (video: HTMLVideoElement) =>
        (video.srcObject as MediaStream).getVideoTracks()[0],
    );
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await expect
    .poll(() => track.evaluate((track) => track.readyState))
    .toBe('ended');
  await expect(page.getByRole('button', { name: 'Use camera' })).toBeEnabled();
});

test('leaving the reader releases its camera', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open a message', exact: true })
    .click();
  await page.getByRole('button', { name: 'Use camera' }).click();
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate(
          (video: HTMLVideoElement) =>
            (video.srcObject as MediaStream | null)?.getVideoTracks()[0]
              ?.readyState,
        ),
    )
    .toBe('live');
  const track = await page
    .locator('video')
    .evaluateHandle(
      (video: HTMLVideoElement) =>
        (video.srcObject as MediaStream).getVideoTracks()[0],
    );
  await page
    .getByRole('button', { name: 'Create a message', exact: true })
    .click();
  await expect(page.getByLabel('Your message')).toBeVisible();
  await expect
    .poll(() => track.evaluate((track) => track.readyState))
    .toBe('ended');
});

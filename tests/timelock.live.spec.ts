import { test, expect } from '@playwright/test';
import { sealMessage } from '../src/lib/payload';

test('unlocks in a real browser using a live future drand beacon', async ({
  page,
}) => {
  test.skip(process.env.LIVE_DRAND !== '1', 'Opt-in network smoke test.');
  test.setTimeout(45_000);
  const encoded = await sealMessage('The real beacon opened this message.', {
    unlockAt: Date.now() + 8000,
  });
  await page.goto(`./#${encoded}`);
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByTestId('revealed-message')).toHaveCount(0);
  await expect(page.getByTestId('revealed-message')).toHaveText(
    'The real beacon opened this message.',
    { timeout: 35_000 },
  );
});

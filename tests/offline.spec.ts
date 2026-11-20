import { expect, test } from '@playwright/test';
import QRCode from 'qrcode';
import { sealGuestMessage } from '../src/lib/guest-message';
import {
  contactText,
  encryptMessage,
  generateIdentity,
  parseContact,
} from '../src/lib/identity/messages';
import { timeForRound } from '../src/lib/timelock';
import beacons from './fixtures/quicknet.json' with { type: 'json' };

test('reopens offline with encrypted history and opens a private link', async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    const credential = () => ({
      rawId: new Uint8Array([44]).buffer,
      getClientExtensionResults: () => ({
        prf: {
          enabled: true,
          results: { first: new Uint8Array(32).fill(44).buffer },
        },
      }),
    });
    Object.defineProperty(navigator, 'credentials', {
      value: {
        create: async () => credential(),
        get: async () => credential(),
      },
    });
  });
  await page.goto('./');
  await expect(page.getByText('Ready offline', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Create profile with passkey' })
    .click();
  await page
    .getByRole('button', { name: 'Verify passkey', exact: true })
    .click();
  await page.getByRole('button', { name: 'Share my contact' }).click();
  const owner = await parseContact(
    await page.getByLabel('My public contact').inputValue(),
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const sender = await generateIdentity('Offline contact');
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await page.getByLabel('Contact to import').fill(contactText(sender.contact));
  await page.getByRole('button', { name: 'Review contact' }).click();
  await page.getByRole('button', { name: 'Save reviewed contact' }).click();
  await page.getByLabel('Private message').fill('Saved before going offline');
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(page.getByTestId('outgoing-message')).toHaveText(
    'Saved before going offline',
  );

  const incoming = await encryptMessage(
    sender,
    owner,
    'Opened entirely offline',
  );
  const url = `${page.url()}?view=offline#${incoming}`;
  await context.setOffline(true);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(url);
  await expect(
    reopened.getByRole('button', { name: 'Unlock with passkey' }),
  ).toBeVisible();
  await reopened.getByRole('button', { name: 'Unlock with passkey' }).click();
  await expect(reopened.getByTestId('identity-plaintext')).toHaveText(
    'Opened entirely offline',
  );
  await expect(reopened.getByTestId('outgoing-message')).toHaveText(
    'Saved before going offline',
  );
  expect(new URL(reopened.url()).search).toBe('?view=offline');
  expect(new URL(reopened.url()).hash).toBe('');
  await reopened.getByLabel('Private message').fill('Created while offline');
  await reopened
    .getByRole('button', { name: 'Create link', exact: true })
    .click();
  await expect(reopened.getByLabel('Encrypted link')).toHaveValue(/#em1\./);

  const timed = await encryptMessage(
    sender,
    owner,
    'Opened a timed file offline',
    timeForRound(992),
  );
  await reopened
    .getByRole('button', { name: 'Open link', exact: true })
    .click();
  await reopened.getByLabel('Import encrypted message file').setInputFiles({
    name: 'timed-message.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(timed),
  });
  await reopened.getByRole('button', { name: 'Unlock timed link' }).click();
  await reopened
    .getByLabel('Public drand beacon JSON')
    .fill(JSON.stringify(beacons['992']));
  await reopened.getByRole('button', { name: 'Import public beacon' }).click();
  await expect(
    reopened
      .getByTestId('identity-plaintext')
      .filter({ hasText: 'Opened a timed file offline' }),
  ).toBeVisible();

  const cachedFiles = await reopened.evaluate(async () => {
    const names = (await caches.keys()).filter((name) =>
      name.startsWith('encrypt-app-shell:'),
    );
    const requests = await Promise.all(
      names.map(async (name) => (await caches.open(name)).keys()),
    );
    return requests.flat().map(({ url }) => url);
  });
  expect(cachedFiles).toContain(new URL('./', url).href);
  expect(cachedFiles.some((url) => url.endsWith('.woff2'))).toBe(true);
  expect(
    cachedFiles.every((url) => !new URL(url).search && !new URL(url).hash),
  ).toBe(true);
});

test('scans and unlocks a guest QR offline without setting up a profile', async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    // Force the bundled QR worker even if the browser has a native detector.
    Object.defineProperty(window, 'BarcodeDetector', {
      value: class {
        static async getSupportedFormats() {
          return [];
        }
      },
    });
  });
  const guest = await sealGuestMessage('Guest opened offline');
  await page.goto('./');
  await expect(page.getByText('Ready offline', { exact: true })).toBeVisible();
  const qr = await QRCode.toBuffer(`${page.url()}#${guest.fragment}`);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Open guest message' }).click();
  await page.getByLabel('Upload QR image').setInputFiles({
    name: 'guest-link.png',
    mimeType: 'image/png',
    buffer: qr,
  });
  const code = page.getByLabel('Unlock code', { exact: true });
  await expect(code).toBeVisible();
  await code.fill(guest.code);
  await page.getByRole('button', { name: 'Unlock message' }).click();
  await expect(page.getByTestId('guest-plaintext')).toHaveText(
    'Guest opened offline',
  );
  await expect(page.getByRole('button', { name: /passkey/ })).toHaveCount(0);
});

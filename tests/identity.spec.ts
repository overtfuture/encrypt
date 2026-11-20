import { linkTestTransports } from './live-transport';
import { test, expect, type Page } from '@playwright/test';
import {
  backupText,
  createVault,
  parseBackup,
} from '../src/lib/identity/vault';
import {
  contactText,
  encryptMessage,
  generateIdentity,
  parseContact,
} from '../src/lib/identity/messages';
import beacons from './fixtures/quicknet.json' with { type: 'json' };

test('setup retries a cancelled assertion with the same registered credential', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let registrations = 0;
    let assertions = 0;
    const credential = (id: number) => ({
      rawId: new Uint8Array([id]).buffer,
      getClientExtensionResults: () => ({
        prf: { results: { first: new Uint8Array(32).fill(16).buffer } },
      }),
    });
    Object.defineProperty(navigator, 'credentials', {
      value: {
        create: async () => credential(++registrations),
        get: async ({ publicKey }: CredentialRequestOptions) => {
          if (++assertions === 1)
            throw new DOMException('Prompt did not finish', 'NotAllowedError');
          return credential(
            new Uint8Array(
              publicKey!.allowCredentials![0].id as ArrayBuffer,
            )[0],
          );
        },
      },
    });
  });
  await page.goto('./');
  await page
    .getByRole('button', { name: 'Create profile with passkey', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Verify passkey', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add contact' })).toHaveCount(
    0,
  );
  await page
    .getByRole('button', { name: 'Verify passkey', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'verification did not finish',
  );
  expect(await localRecords(page)).not.toContain('ev1.');
  await page
    .getByRole('button', { name: 'Verify passkey', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Add contact' })).toBeVisible();
  const saved = await localRecords(page);
  const backup = JSON.parse(saved)[0]
    .flat()
    .find(
      (value: unknown) => typeof value === 'string' && value.startsWith('ev1.'),
    );
  expect(parseBackup(backup).binding.id).toBe('AQ');
});

test('the profile gate hides contacts and message import until passkey unlock', async ({
  page,
}) => {
  await mockPasskeys(page, 13);
  await page.goto('./');
  await expect(
    page.getByRole('button', { name: 'Create profile with passkey' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add contact' })).toHaveCount(
    0,
  );
  await expect(page.getByLabel('Contact to import')).toHaveCount(0);
  await expect(page.getByLabel('Encrypted message to open')).toHaveCount(0);
  await finishProfileSetup(page);
  await expect(page.getByRole('button', { name: 'Add contact' })).toBeVisible();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Unlock with passkey' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add contact' })).toHaveCount(
    0,
  );
});

test('first-time users get a clear choice between starting a chat and sharing with a guest', async ({
  page,
}) => {
  await mockPasskeys(page, 33);
  await page.goto('./');
  await expect(page.getByText(/A passkey lets you unlock/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reset this browser' }),
  ).toBeHidden();
  await finishProfileSetup(page);
  const start = page.getByRole('region', { name: 'Start a private chat' });
  await expect(
    start.getByRole('button', { name: 'Add contact' }),
  ).toBeVisible();
  await start.getByRole('button', { name: 'New guest message' }).click();
  await expect(page.getByLabel('Message for guest')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await start.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByLabel('Contact to import')).toBeVisible();
});

test('enrollment uses the same PRF assertion path as unlock after reload', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const response = (seed: number) => ({
      rawId: new Uint8Array([17]).buffer,
      getClientExtensionResults: () => ({
        prf: {
          enabled: true,
          results: { first: new Uint8Array(32).fill(seed).buffer },
        },
      }),
    });
    Object.defineProperty(navigator, 'credentials', {
      value: { create: async () => response(1), get: async () => response(2) },
    });
  });
  await page.goto('./');
  await finishProfileSetup(page);
  await expect(
    page.getByRole('button', { name: 'Lock', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: 'Unlock with passkey', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Lock', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('corrupted vault metadata fails safely without replacing saved identity', async ({
  page,
}) => {
  await mockPasskeys(page, 9);
  await page.goto('./');
  await finishProfileSetup(page);
  await expect(
    page.getByRole('button', { name: 'Lock', exact: true }),
  ).toBeVisible();
  const damaged = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('encrypt-this-identities-v1');
      r.onsuccess = () => resolve(r.result);
    });
    const result = await new Promise<string>((resolve) => {
      const tx = db.transaction('vault', 'readwrite'),
        s = tx.objectStore('vault'),
        r = s.get('identity');
      let changed = '';
      r.onsuccess = () => {
        const raw = r.result.slice(4).replaceAll('-', '+').replaceAll('_', '/');
        const record = JSON.parse(atob(raw));
        record.contact.id = '!';
        changed =
          'ev1.' +
          btoa(JSON.stringify(record))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replace(/=+$/, '');
        s.put(changed, 'identity');
      };
      tx.oncomplete = () => resolve(changed);
    });
    db.close();
    return result;
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('cannot be read');
  await expect(
    page.getByRole('button', {
      name: 'Create profile with passkey',
      exact: true,
    }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
  expect(damaged).toContain('ev1.');
});

test('date-based passkey messages need a verified imported beacon even after a clock jump', async ({
  page,
}) => {
  await mockPasskeys(page, 7);
  await page.clock.install({ time: new Date('2023-08-23T15:58:00Z') });
  await page.goto('./');
  await finishProfileSetup(page);
  await addCard(page, await shareCard(page));
  await page.getByLabel('Private message').fill('Scheduled private message');
  await page.getByLabel('Set an opening time').check();
  await page.getByLabel('Opening date and time').fill('2023-08-23T15:59');
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  const message = await page.getByLabel('Encrypted link').inputValue();
  expect(new URL(message).hash.startsWith('#et1.')).toBe(true);
  await visitLink(page, message);
  await unlock(page);
  await page.clock.fastForward(61000);
  await page.getByRole('button', { name: 'Unlock timed link' }).click();
  await expect(page.getByTestId('identity-plaintext')).toHaveCount(0);
  await page
    .getByLabel('Public drand beacon JSON')
    .fill(JSON.stringify(beacons['1000']));
  await page.getByRole('button', { name: 'Import public beacon' }).click();
  await expect(page.getByRole('alert')).toContainText('another opening time');
  await page.getByLabel('Public drand beacon JSON').fill(
    JSON.stringify({
      ...beacons['992'],
      signature: beacons['1000'].signature,
    }),
  );
  await page.getByRole('button', { name: 'Import public beacon' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('identity-plaintext')).toHaveCount(0);
  await page
    .getByLabel('Public drand beacon JSON')
    .fill(JSON.stringify(beacons['992']));
  await page.getByRole('button', { name: 'Import public beacon' }).click();
  await expect(page.getByTestId('identity-plaintext')).toHaveText(
    'Scheduled private message',
  );
  await visitLink(page, message);
  await unlock(page);
  await expect(page.getByTestId('identity-plaintext')).toHaveText(
    'Scheduled private message',
  );
  await expect(
    page.getByRole('button', { name: 'Unlock timed link' }),
  ).toHaveCount(0);
});

test('a lock during recovery commit keeps committed backup metadata but clears the session', async ({
  page,
}) => {
  await mockPasskeys(page, 8);
  await page.goto('./');
  await finishProfileSetup(page);
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page
    .getByRole('button', { name: 'Set up recovery code', exact: true })
    .click();
  const code = await page.locator('code.fingerprint').innerText();
  await page.getByLabel('Re-enter saved recovery code').fill(code);
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      IDBTransaction.prototype,
      'oncomplete',
    )!;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...descriptor,
      set(this: IDBTransaction, handler: (event: Event) => void) {
        if (
          this.mode === 'readwrite' &&
          this.objectStoreNames.contains('vault')
        )
          descriptor.set!.call(this, (event: Event) => {
            (window as any).__vaultCommitted = true;
            setTimeout(() => handler.call(this, event), 1500);
          });
        else descriptor.set!.call(this, handler);
      },
    });
  });
  await page
    .getByRole('button', { name: 'Confirm saved recovery code', exact: true })
    .click();
  await page.waitForFunction(() => (window as any).__vaultCommitted);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Unlock with passkey', exact: true }),
  ).toBeVisible();
  await page
    .getByText('Backup, recovery & compatibility', { exact: true })
    .click();
  await expect
    .poll(async () => {
      const download = page.waitForEvent('download');
      await page
        .getByRole('button', { name: 'Export encrypted backup', exact: true })
        .click();
      const d = await download;
      const stream = await d.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      return (
        JSON.parse(
          Buffer.from(
            Buffer.concat(chunks).toString().slice(4),
            'base64url',
          ).toString(),
        ).recovery !== undefined
      );
    })
    .toBe(true);
  await expect(page.locator('code.fingerprint')).toHaveCount(0);
  await expect(page.getByLabel('Private message')).toHaveCount(0);
});

test('rejects oversized fragments without breaking the app', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#' + 'A'.repeat(92001));
  await expect(page.getByLabel('Display name')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('large');
  expect(new URL(page.url()).hash).toBe('');
  expect(errors).toEqual([]);
});

test('a corrupt contact does not hide the existing vault or backup controls', async ({
  page,
}) => {
  await mockPasskeys(page, 6);
  await page.goto('./');
  await finishProfileSetup(page);
  await expect(
    page.getByRole('button', { name: 'Lock', exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('encrypt-this-identities-v1');
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('contacts', 'readwrite');
      tx.objectStore('contacts').put({ broken: true }, 'bad');
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Unlock with passkey', exact: true }),
  ).toBeVisible();
  await page
    .getByText('Backup, recovery & compatibility', { exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Export encrypted backup', exact: true }),
  ).toBeVisible();
  await unlock(page);
  await expect(page.getByRole('alert')).toContainText('contact');
});

// This substitutes only the WebAuthn boundary. HPKE, vault crypto and IndexedDB are real.
async function mockPasskeys(page: Page, seed: number) {
  await page.addInitScript((seed) => {
    const credential = () => ({
      rawId: new Uint8Array([seed]).buffer,
      getClientExtensionResults: () => ({
        prf: {
          enabled: true,
          results: { first: new Uint8Array(32).fill(seed).buffer },
        },
      }),
    });
    Object.defineProperty(navigator, 'credentials', {
      value: {
        create: async () => credential(),
        get: async () => credential(),
      },
    });
  }, seed);
}
async function visitLink(page: Page, url: string) {
  await page.goto('about:blank');
  await page.goto(url);
}

async function unlock(page: Page) {
  await page
    .getByRole('button', { name: 'Unlock with passkey', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Lock', exact: true }),
  ).toBeVisible();
}

async function finishProfileSetup(page: Page) {
  await page
    .getByRole('button', { name: 'Create profile with passkey', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Verify passkey', exact: true })
    .click();
}

async function createProfile(page: Page, name: string) {
  await page.getByLabel(/Display name/).fill(name);
  await finishProfileSetup(page);
  await expect(
    page.getByRole('button', { name: 'Lock', exact: true }),
  ).toBeVisible();
}

async function showContactList(page: Page) {
  const back = page.getByRole('button', { name: 'Contacts', exact: true });
  if (await back.isVisible()) await back.click();
}

async function shareCard(page: Page) {
  await page
    .getByRole('button', { name: 'Share my contact', exact: true })
    .click();
  const card = await page.getByLabel('My public contact').inputValue();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return card;
}

async function addCard(page: Page, card: string, sender = false) {
  if (!sender) await showContactList(page);
  await page
    .getByRole('button', {
      name: sender ? 'Add sender' : 'Add contact',
      exact: true,
    })
    .click();
  await page.getByLabel('Contact to import').fill(card);
  await page.getByRole('button', { name: 'Review contact' }).click();
  await page.getByRole('button', { name: 'Save reviewed contact' }).click();
  await expect(page.getByLabel('Private message')).toBeVisible();
}

async function createLink(page: Page, body: string) {
  await page.getByLabel('Private message').fill(body);
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Link ready');
  return page.getByLabel('Encrypted link').inputValue();
}

async function openStoredContact(page: Page, name: string) {
  await showContactList(page);
  await page.getByRole('button', { name: new RegExp('^' + name) }).click();
}

async function openContactActions(page: Page, name: string) {
  await showContactList(page);
  await page.getByLabel(`Actions for ${name}`, { exact: true }).click();
}

test('sent and received messages render Markdown in the conversation', async ({
  page,
}) => {
  await mockPasskeys(page, 28);
  await page.goto('./');
  await createProfile(page, 'Local sender');
  const recipient = await parseContact(await shareCard(page));
  const sender = await generateIdentity('Saved contact');
  await addCard(page, contactText(sender.contact));
  await createLink(page, '**Sent in bold**');
  await expect(
    page.getByTestId('outgoing-message').locator('strong'),
  ).toHaveText('Sent in bold');

  const inbound = await encryptMessage(sender, recipient, '> Received quote');
  await page.getByRole('button', { name: 'Open link', exact: true }).click();
  await page.getByLabel('Encrypted message to open').fill(inbound);
  await page.getByRole('button', { name: 'Open message', exact: true }).click();
  await expect(
    page.getByTestId('identity-plaintext').locator('blockquote'),
  ).toHaveText('Received quote');
});

test('private Markdown preview preserves the draft and resets after creating a link', async ({
  page,
}) => {
  await mockPasskeys(page, 31);
  await page.goto('./');
  await expect(page).toHaveTitle('encrypt');
  await createProfile(page, 'Local sender');
  const contact = await generateIdentity('Saved contact');
  await addCard(page, contactText(contact.contact));

  const draft = '**Private draft**';
  await page.getByLabel('Private message').fill(draft);
  await page.getByRole('button', { name: 'Preview Markdown' }).click();
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  await expect(preview.locator('strong')).toHaveText('Private draft');
  await expect(page.getByTestId('outgoing-message')).toHaveCount(0);
  expect(await localRecords(page)).not.toContain('Private draft');
  await page.getByRole('button', { name: 'Edit message' }).click();
  await expect(page.getByLabel('Private message')).toHaveValue(draft);
  await page.getByRole('button', { name: 'Preview Markdown' }).click();
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(
    page.getByTestId('outgoing-message').locator('strong'),
  ).toHaveText('Private draft');
  await expect(preview).toHaveCount(0);
  await expect(page.getByLabel('Private message')).toBeEmpty();
});

test('resetting from the locked screen clears app data in open tabs', async ({
  page,
  context,
}) => {
  await mockPasskeys(page, 26);
  await page.goto('./');
  await createProfile(page, 'Profile to reset');
  const owner = await parseContact(await shareCard(page));
  const contact = await generateIdentity('Saved contact');
  await addCard(page, contactText(contact.contact));
  await createLink(page, 'Saved chat');

  const stranger = await generateIdentity('Unknown sender');
  const incoming = await encryptMessage(stranger, owner, 'Waiting for contact');
  await page.getByRole('button', { name: 'Open link', exact: true }).click();
  await page.getByLabel('Encrypted message to open').fill(incoming);
  await page.getByRole('button', { name: 'Open message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add sender' })).toBeVisible();

  const otherTab = await context.newPage();
  await mockPasskeys(otherTab, 26);
  await otherTab.goto('./');
  await unlock(otherTab);
  await expect(
    otherTab.getByRole('button', { name: /^Saved contact/ }),
  ).toBeVisible();
  await otherTab.evaluate(() => {
    sessionStorage.setItem('encrypt-this/staged-links', '[]');
  });

  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.evaluate((card) => {
    localStorage.setItem('another-app', 'keep');
    sessionStorage.setItem('another-app', 'keep');
    location.hash = card;
  }, contactText(contact.contact));
  await expect(
    page.getByText('A link is waiting for you after unlock.'),
  ).toBeVisible();

  await page
    .getByText('Backup, recovery & compatibility', { exact: true })
    .click();
  const reset = page.getByRole('button', { name: 'Reset this browser' });
  await expect(reset).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await reset.click();
  await expect(
    page.getByRole('button', { name: 'Unlock with passkey' }),
  ).toBeVisible();
  expect(
    JSON.parse(await localRecords(page))[0].map(
      (store: unknown[]) => store.length,
    ),
  ).toEqual([1, 1, 1, 1]);

  page.once('dialog', (dialog) => dialog.accept());
  await reset.click();
  for (const tab of [page, otherTab]) {
    await expect(
      tab.getByRole('heading', { name: 'Create your profile' }),
    ).toBeVisible();
    await expect(
      tab.getByText('A link is waiting for you after unlock.'),
    ).toHaveCount(0);
    const [stores, session, local] = JSON.parse(await localRecords(tab));
    expect(stores).toEqual([[], [], [], []]);
    expect(session['encrypt-this/staged-links']).toBeUndefined();
    expect(local['another-app']).toBe('keep');
  }
  expect(await page.evaluate(() => sessionStorage.getItem('another-app'))).toBe(
    'keep',
  );
  await createProfile(page, 'Fresh profile');
  await expect(
    page.getByRole('region', { name: 'Start a private chat' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Saved contact/ }),
  ).toHaveCount(0);
});

test('a reset waits for a tab holding the database to close', async ({
  page,
  context,
}) => {
  await mockPasskeys(page, 27);
  await page.goto('./');
  await createProfile(page, 'Profile to reset');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();

  const blocker = await context.newPage();
  await blocker.goto('./');
  await blocker.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('encrypt-this-identities-v1');
        request.onsuccess = () => {
          Object.defineProperty(window, 'blockingConnection', {
            value: request.result,
          });
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );

  await page
    .getByText('Backup, recovery & compatibility', { exact: true })
    .click();
  const reset = page.getByRole('button', { name: 'Reset this browser' });
  await expect(reset).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await reset.click();
  await expect(page.getByRole('alert')).toContainText('Close other tabs');
  await expect(
    page.getByRole('button', { name: 'Unlock with passkey' }),
  ).toBeDisabled();
  await blocker.close();
  await expect(
    page.getByRole('heading', { name: 'Create your profile' }),
  ).toBeVisible();
});

async function createGuestMessage(page: Page, message: string) {
  await mockPasskeys(page, 25);
  await page.goto('./');
  await createProfile(page, 'Local sender');
  const compose = page.getByRole('button', { name: 'New guest message' });
  await expect(compose).toBeVisible();
  await compose.click();
  await page.getByLabel('Message for guest').fill(message);
  await page.getByRole('button', { name: 'Encrypt guest message' }).click();
}

test('guest Markdown preview uses the same formatting and safe image links as opened messages', async ({
  page,
}) => {
  await mockPasskeys(page, 32);
  await page.goto('./');
  await createProfile(page, 'Guest sender');
  await page.getByRole('button', { name: 'New guest message' }).click();
  const draft =
    '# Guest note\n\n![Picture](https://example.com/picture.png)\n\n<b>Raw HTML</b>';
  await page.getByLabel('Message for guest').fill(draft);
  await page.getByRole('button', { name: 'Preview Markdown' }).click();
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  await expect(
    preview.getByRole('heading', { name: 'Guest note' }),
  ).toBeVisible();
  await expect(
    preview.getByRole('link', { name: 'Image: Picture' }),
  ).toBeVisible();
  await expect(preview.locator('img, b')).toHaveCount(0);
  await expect(preview).toContainText('<b>Raw HTML</b>');
  await page.getByRole('button', { name: 'Edit message' }).click();
  await expect(page.getByLabel('Message for guest')).toHaveValue(draft);
  await page.getByRole('button', { name: 'Preview Markdown' }).click();
  await page.getByRole('button', { name: 'Encrypt guest message' }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByLabel('Guest message link')).toBeVisible();
});

test('a guest can open a shared contact card and review it before saving', async ({
  page,
  browser,
  baseURL,
  viewport,
}) => {
  await mockPasskeys(page, 29);
  await page.goto('./');
  await createProfile(page, 'Guest sender');
  await page
    .getByRole('button', { name: 'Share my contact', exact: true })
    .click();
  const publicLink = await page
    .getByLabel('My contact link', { exact: true })
    .inputValue();
  const share = page.getByRole('button', { name: 'Share as guest link' });
  await expect(share).toBeVisible();
  await share.click();
  await expect(page.getByLabel('Include my contact')).toBeChecked();
  await page.getByRole('button', { name: 'Encrypt contact card' }).click();
  const detached = await page.getByLabel('Guest message link').inputValue();
  const code = await page.getByLabel('Guest unlock code').inputValue();
  expect(detached).not.toContain(code);
  expect(detached).not.toContain(new URL(publicLink).hash.slice(1));
  await page.getByText('Sharing options', { exact: true }).click();
  await page.getByLabel('Include unlock code with link and QR').check();
  const bundled = await page.getByLabel('Guest message link').inputValue();

  const context = await browser.newContext({ baseURL, viewport });
  try {
    const guest = await context.newPage();
    await mockPasskeys(guest, 30);
    await guest.goto(detached);
    const card = guest.getByRole('region', { name: 'Shared contact' });
    await expect(card).toHaveCount(0);
    await guest.getByLabel('Unlock code', { exact: true }).fill(code);
    await guest.getByRole('button', { name: 'Unlock message' }).click();
    await expect(card).toContainText('Guest sender');
    await expect(guest.getByRole('button', { name: /passkey/ })).toHaveCount(0);
    await expect(guest.getByTestId('guest-plaintext')).toHaveCount(0);
    const add = card.getByRole('link', { name: 'Review and add contact' });
    await expect(add).toHaveAttribute('href', publicLink);

    await visitLink(guest, bundled);
    await expect(card).toContainText('Guest sender');
    await add.click();
    await expect(
      guest.getByText('A link is waiting for you after unlock.'),
    ).toBeVisible();
    await createProfile(guest, 'Guest recipient');
    await expect(
      guest.getByText('Guest sender', { exact: true }),
    ).toBeVisible();
    await guest.getByRole('button', { name: 'Save reviewed contact' }).click();
    await expect(
      guest.getByRole('region', { name: 'Conversation with Guest sender' }),
    ).toBeVisible();
    await expect(
      guest.getByText('Unverified', { exact: true }).last(),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a guest can open an encrypted link with a separately shared code', async ({
  page,
  browser,
  baseURL,
  viewport,
}) => {
  const message = 'Private 🌿 <img src=https://example.com/pixel>';
  await createGuestMessage(page, message);
  const sharing = page.getByRole('region', { name: 'New guest message' });
  await expect(sharing.getByRole('heading', { level: 3 })).toHaveText([
    'Guest message',
    'Separate unlock code',
  ]);
  const messageSection = sharing.getByRole('region', {
    name: 'Guest message',
    exact: true,
  });
  const codeSection = sharing.getByRole('region', {
    name: 'Separate unlock code',
    exact: true,
  });
  const link = await messageSection
    .getByLabel('Guest message link')
    .inputValue();
  const code = await codeSection.getByLabel('Guest unlock code').inputValue();
  expect(code).toMatch(/^[\w-]{22}$/);
  expect(link).not.toContain(code);
  expect(decodeURIComponent(link)).not.toContain(message);
  const showCodeQr = codeSection.getByLabel('Show unlock code QR');
  const codeQr = codeSection.getByRole('img', { name: 'Guest unlock code QR' });
  await expect(showCodeQr).toBeVisible();
  await expect(codeQr).toHaveCount(0);
  await showCodeQr.check();
  const image = await codeQr.screenshot();
  await expect(page.getByLabel('Guest message link')).toHaveValue(link);
  await showCodeQr.uncheck();
  await expect(codeQr).toHaveCount(0);
  const linkImage = await messageSection
    .getByRole('img', { name: 'Guest message QR code' })
    .screenshot();

  const context = await browser.newContext({ baseURL, viewport });
  try {
    const guest = await context.newPage();
    await guest.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        get: () => {
          throw new Error('Storage unavailable');
        },
      });
    });
    await guest.goto(link);
    await expect(
      guest.getByRole('heading', { name: 'Guest message' }),
    ).toBeVisible();
    await expect(guest.getByRole('button', { name: /passkey/ })).toHaveCount(0);
    const rendered = guest.getByTestId('guest-plaintext');
    await expect(rendered).toHaveCount(0);
    const input = guest.getByLabel('Unlock code', { exact: true });
    const upload = guest.getByLabel('Upload unlock code QR image');
    await upload.setInputFiles({
      name: 'message-link.png',
      mimeType: 'image/png',
      buffer: linkImage,
    });
    await expect(guest.getByRole('alert')).toContainText('unlock code QR');
    await expect(input).toHaveValue('');
    await input.fill('A'.repeat(22));
    await guest.getByRole('button', { name: 'Unlock message' }).click();
    await expect(guest.getByRole('alert')).toContainText('couldn’t open');
    await guest
      .getByRole('button', { name: 'Use a different guest link' })
      .click();
    const linkField = guest.getByLabel('Paste a guest message link');
    await expect(linkField).toBeFocused();
    await expect(guest.getByRole('alert')).toHaveCount(0);
    await linkField.fill(link);
    await guest.getByRole('button', { name: 'Open link', exact: true }).click();
    await expect(input).toBeEmpty();
    await upload.setInputFiles({
      name: 'unlock-code.png',
      mimeType: 'image/png',
      buffer: image,
    });
    await expect(input).toHaveValue(code);
    await expect(rendered).toHaveCount(0);
    await guest.getByRole('button', { name: 'Unlock message' }).click();
    await expect(rendered).toHaveText(message);
    await expect(guest.locator('img')).toHaveCount(0);
    expect(new URL(guest.url()).hash).toBe('');
    await guest.reload();
    await expect(rendered).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a QR code with the unlock code opens a guest message in one scan', async ({
  page,
  browser,
  baseURL,
  viewport,
}) => {
  const message = 'A message for the guest';
  await createGuestMessage(page, `## ${message}`);
  const code = await page.getByLabel('Guest unlock code').inputValue();
  const includeCode = page.getByLabel('Include unlock code with link and QR');
  await expect(includeCode).toBeHidden();
  await page.getByText('Sharing options', { exact: true }).click();
  await expect(includeCode).not.toBeChecked();
  await page.getByLabel('Show unlock code QR').check();
  await expect(
    page.getByRole('img', { name: 'Guest unlock code QR' }),
  ).toBeVisible();
  await includeCode.check();
  const sharing = page.getByRole('region', { name: 'New guest message' });
  await expect(sharing.getByRole('heading', { level: 3 })).toHaveText([
    'Guest message',
  ]);
  await expect(sharing.getByRole('img')).toHaveCount(1);
  await expect(sharing.getByLabel('Guest unlock code')).toHaveCount(0);
  const bundled = await page.getByLabel('Guest message link').inputValue();
  expect(new URL(bundled).hash).toContain(code);
  const image = await page
    .getByRole('img', { name: 'Guest message QR code' })
    .screenshot();
  await includeCode.uncheck();
  await expect(page.getByLabel('Guest message link')).not.toHaveValue(bundled);

  const context = await browser.newContext({ baseURL, viewport });
  try {
    const guest = await context.newPage();
    await guest.goto('./');
    await guest.getByRole('button', { name: 'Open guest message' }).click();
    await guest.getByLabel('Upload QR image').setInputFiles({
      name: 'guest-message.png',
      mimeType: 'image/png',
      buffer: image,
    });
    const rendered = guest.getByRole('heading', { name: message, exact: true });
    await expect(rendered).toBeVisible();
    await expect(guest.getByLabel('Unlock code', { exact: true })).toHaveCount(
      0,
    );
    await guest.getByRole('button', { name: 'Close guest message' }).click();
    await expect(rendered).toHaveCount(0);

    await guest.goto(bundled);
    await expect(rendered).toBeVisible();
    expect(new URL(guest.url()).hash).toBe('');
  } finally {
    await context.close();
  }
});

test('deleting a contact updates open tabs and keeps saved messages available on re-add', async ({
  page,
  context,
}) => {
  await mockPasskeys(page, 23);
  await page.goto('./');
  await createProfile(page, 'Local profile');
  const recipient = await parseContact(await shareCard(page));
  const alice = await generateIdentity('Alice');
  const aliceCard = contactText(alice.contact);
  const bob = await generateIdentity('Bob');
  await addCard(page, contactText(bob.contact));
  await addCard(page, aliceCard);

  const body = 'A saved message from Alice';
  const message = await encryptMessage(alice, recipient, body);
  const openMessage = async () => {
    await page.getByRole('button', { name: 'Open link', exact: true }).click();
    await page.getByLabel('Encrypted message to open').fill(message);
    await page
      .getByRole('button', { name: 'Open message', exact: true })
      .click();
  };
  await openMessage();
  await expect(page.getByTestId('identity-plaintext')).toHaveText(body);

  const otherTab = await context.newPage();
  await mockPasskeys(otherTab, 23);
  await otherTab.goto('./');
  await unlock(otherTab);
  await openStoredContact(otherTab, 'Alice');
  await otherTab.getByLabel('Private message').fill('Draft in another tab');
  await otherTab.getByRole('button', { name: 'Contact details' }).click();

  await openContactActions(page, 'Alice');
  const deleteButton = page.getByRole('button', { name: 'Delete contact' });
  page.once('dialog', (dialog) => dialog.dismiss());
  await deleteButton.click();
  await expect(page.getByRole('button', { name: /^Alice/ })).toBeVisible();

  await openContactActions(page, 'Alice');
  page.once('dialog', (dialog) => dialog.accept());
  await deleteButton.click();
  for (const tab of [page, otherTab]) {
    await expect(tab.getByRole('button', { name: /^Alice/ })).toHaveCount(0);
    await expect(tab.getByRole('button', { name: /^Bob/ })).toBeVisible();
    await expect(
      tab.getByRole('region', { name: 'Contact details' }),
    ).toHaveCount(0);
  }

  await page.reload();
  await unlock(page);
  await expect(page.getByRole('button', { name: /^Alice/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Bob/ })).toBeVisible();
  await openMessage();
  await expect(page.getByRole('button', { name: 'Add sender' })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss link' }).click();
  await expect(page.getByRole('button', { name: 'Add sender' })).toHaveCount(0);
  await addCard(page, aliceCard);
  await expect(page.getByTestId('identity-plaintext')).toHaveText(body);
  await openStoredContact(otherTab, 'Alice');
  await expect(otherTab.getByLabel('Private message')).toHaveValue('');
});

test('clearing a thread removes sent and received messages while keeping both contacts', async ({
  page,
  context,
}) => {
  await mockPasskeys(page, 24);
  await page.goto('./');
  await createProfile(page, 'Local profile');
  const recipient = await parseContact(await shareCard(page));
  const alice = await generateIdentity('Alice');
  const bob = await generateIdentity('Bob');
  await addCard(page, contactText(bob.contact));
  await createLink(page, 'Keep this message for Bob');
  await addCard(page, contactText(alice.contact));
  await createLink(page, 'Clear this reply to Alice');
  const inbound = await encryptMessage(
    alice,
    recipient,
    'Clear this message from Alice',
  );
  await page.getByRole('button', { name: 'Open link', exact: true }).click();
  await page.getByLabel('Encrypted message to open').fill(inbound);
  await page.getByRole('button', { name: 'Open message', exact: true }).click();
  await expect(page.getByTestId('identity-plaintext')).toBeVisible();

  const otherTab = await context.newPage();
  await mockPasskeys(otherTab, 24);
  await otherTab.goto('./');
  await unlock(otherTab);
  await openStoredContact(otherTab, 'Alice');
  await expect(otherTab.getByTestId('outgoing-message')).toBeVisible();

  await openContactActions(page, 'Alice');
  const clearButton = page.getByRole('button', { name: 'Clear messages' });
  page.once('dialog', (dialog) => dialog.dismiss());
  await clearButton.click();
  await openStoredContact(page, 'Alice');
  await expect(page.getByTestId('identity-plaintext')).toBeVisible();
  await expect(page.getByTestId('outgoing-message')).toBeVisible();

  await openContactActions(page, 'Alice');
  page.once('dialog', (dialog) => dialog.accept());
  await clearButton.click();
  await expect(otherTab.getByText('Start the conversation')).toBeVisible();
  await expect(otherTab.getByTestId('identity-plaintext')).toHaveCount(0);
  await expect(otherTab.getByTestId('outgoing-message')).toHaveCount(0);

  await page.reload();
  await unlock(page);
  await openStoredContact(page, 'Alice');
  await expect(page.getByText('Start the conversation')).toBeVisible();
  await openStoredContact(page, 'Bob');
  await expect(page.getByTestId('outgoing-message')).toHaveText(
    'Keep this message for Bob',
  );
});

test('two profiles exchange links, authenticate first contact, and reload encrypted history', async ({
  browser,
  baseURL,
  viewport,
}) => {
  const a = await browser.newContext({ baseURL, viewport });
  const b = await browser.newContext({ baseURL, viewport });
  const alice = await a.newPage();
  const bob = await b.newPage();
  const requests: string[] = [];
  for (const page of [alice, bob]) {
    page.on('request', (r) => {
      if (!r.url().startsWith(new URL(baseURL!).origin)) requests.push(r.url());
    });
  }
  await mockPasskeys(alice, 1);
  await mockPasskeys(bob, 2);
  await alice.goto('./');
  await createProfile(alice, 'Alice');
  await alice
    .getByRole('button', { name: 'Share my contact', exact: true })
    .click();
  const ac = await alice.getByLabel('My public contact').inputValue();
  const aliceContactLink = await alice
    .getByLabel('My contact link', { exact: true })
    .inputValue();
  await alice.getByRole('button', { name: 'Done', exact: true }).click();

  await bob.goto(aliceContactLink);
  await expect(bob.getByText('A link is waiting')).toBeVisible();
  await expect(bob.getByLabel('Contact to import')).toHaveCount(0);
  await createProfile(bob, 'Bob');
  await expect(bob.getByLabel('Contact to import')).toHaveValue(ac);
  await bob.getByRole('button', { name: 'Done', exact: true }).click();
  const bc = await shareCard(bob);
  await addCard(alice, bc);

  const firstBody = 'Only Bob can read 🌿 <img src=https://example.com/pixel>';
  const first = await createLink(alice, firstBody);
  await visitLink(bob, first);
  await expect(bob.getByText('A link is waiting')).toBeVisible();
  await bob.reload();
  await expect(bob.getByText('A link is waiting')).toBeVisible();
  await expect(bob.getByTestId('identity-plaintext')).toHaveCount(0);
  await unlock(bob);
  await expect(bob.getByText('Add the sender’s contact card')).toBeVisible();
  await bob.reload();
  await unlock(bob);
  await expect(bob.getByRole('button', { name: 'Add sender' })).toBeVisible();
  await addCard(bob, ac, true);
  await expect(bob.getByTestId('identity-plaintext')).toHaveText(firstBody);
  await expect(
    bob
      .getByRole('region', { name: 'Conversation with Alice' })
      .getByText('Unverified'),
  ).toBeVisible();

  if (viewport && viewport.width < 500) {
    await bob.setViewportSize({ width: 320, height: viewport.height });
  }
  await bob
    .getByRole('button', { name: 'Share my contact', exact: true })
    .click();
  const contactLink = await bob
    .getByLabel('My contact link', { exact: true })
    .inputValue();
  expect(new URL(contactLink).hash).toBe('#' + bc);
  await bob.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    bob.getByRole('region', { name: 'Conversation with Alice' }),
  ).toBeVisible();

  const reply = await createLink(bob, 'Reply from Bob');
  await visitLink(alice, reply);
  await unlock(alice);
  await expect(alice.getByTestId('identity-plaintext')).toHaveText(
    'Reply from Bob',
  );
  await expect(alice.getByTestId('outgoing-message')).toHaveText(firstBody);
  await alice.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(alice.getByLabel('Encrypted link')).toHaveValue(first);

  const second = await createLink(alice, 'Second message for Bob');
  const otherTab = await b.newPage();
  await mockPasskeys(otherTab, 2);
  await Promise.all([visitLink(bob, second), visitLink(otherTab, second)]);
  await Promise.all([unlock(bob), unlock(otherTab)]);
  for (const tab of [bob, otherTab]) {
    await expect(tab.getByTestId('identity-plaintext')).toHaveText([
      firstBody,
      'Second message for Bob',
    ]);
  }
  await visitLink(bob, second);
  await unlock(bob);
  await expect(bob.getByTestId('identity-plaintext')).toHaveCount(2);
  await bob.getByLabel('Private message').fill('draft that should disappear');
  const persisted = await localRecords(bob);
  for (const text of [
    firstBody,
    'Second message for Bob',
    'Reply from Bob',
    'draft that should disappear',
    new URL(reply).hash.slice(1),
  ]) {
    expect(persisted).not.toContain(text);
  }
  await bob.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(bob.getByTestId('identity-plaintext')).toHaveCount(0);
  await bob.reload();
  await unlock(bob);
  await openStoredContact(bob, 'Alice');
  await expect(bob.getByTestId('identity-plaintext')).toHaveCount(2);
  await expect(bob.getByLabel('Private message')).toHaveValue('');
  expect(requests).toEqual([]);
  await a.close();
  await b.close();
});

async function localRecords(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('encrypt-this-identities-v1');
      request.onsuccess = () => resolve(request.result);
    });
    const values = await Promise.all(
      Array.from(
        db.objectStoreNames,
        (store) =>
          new Promise((resolve) => {
            const request = db.transaction(store).objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result);
          }),
      ),
    );
    db.close();
    return JSON.stringify(
      [values, { ...sessionStorage }, { ...localStorage }],
      (_key, value) =>
        value instanceof ArrayBuffer ? new TextDecoder().decode(value) : value,
    );
  });
}

test('backup restoration and recovery with a new passkey preserve identity; storage contains no secrets', async ({
  browser,
  baseURL,
}) => {
  const a = await browser.newContext({ baseURL }),
    b = await browser.newContext({ baseURL });
  const page = await a.newPage(),
    restored = await b.newPage();
  await mockPasskeys(page, 3);
  await mockPasskeys(restored, 4);
  await page.goto('./');
  await page.getByLabel('Display name').fill('Recovery test');
  await finishProfileSetup(page);
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page
    .getByRole('button', { name: 'Set up recovery code', exact: true })
    .click();
  const code = await page.locator('code.fingerprint').innerText();
  await page.getByLabel('Re-enter saved recovery code').fill(code);
  await page
    .getByRole('button', { name: 'Confirm saved recovery code', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Recovery configured');
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export encrypted backup', exact: true })
    .click();
  const file = await download;
  await restored.goto('./');
  await restored
    .getByText('Backup, recovery & compatibility', { exact: true })
    .click();
  await restored
    .getByLabel('Import backup file')
    .setInputFiles((await file.path())!);
  await restored
    .getByRole('button', { name: 'Restore with passkey', exact: true })
    .click();
  await expect(restored.getByRole('alert')).toContainText('does not match');
  await restored.getByLabel('Recovery code', { exact: true }).fill(code);
  await restored
    .getByRole('button', { name: 'Recover with new passkey', exact: true })
    .click();
  await expect(
    restored.getByRole('button', { name: 'Lock', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const restoredCard = await shareCard(restored);
  expect(restoredCard).toBe(await shareCard(page));
  await addCard(restored, restoredCard);
  await restored.getByLabel('Private message').fill('never persist this draft');
  const persisted = await localRecords(restored);
  expect(persisted).not.toContain('never persist this draft');
  expect(persisted).not.toContain(code);
  expect(persisted).not.toContain('privateKey');
  await restored.reload();
  await restored
    .getByRole('button', { name: 'Unlock with passkey', exact: true })
    .click();
  await openStoredContact(restored, 'Recovery test');
  await expect(restored.getByLabel('Private message')).toHaveValue('');
  await a.close();
  await b.close();
});

test('contact QR scans locally, fragments are cleared, and idle lock clears draft', async ({
  page,
}) => {
  await mockPasskeys(page, 5);
  await page.clock.install();
  await page.goto('./');
  await page.getByLabel('Display name').fill('N'.repeat(80));
  await finishProfileSetup(page);
  await page
    .getByRole('button', { name: 'Share my contact', exact: true })
    .click();
  const card = await page.getByLabel('My public contact').inputValue();
  const qr = page.getByRole('img', { name: 'My public contact QR code' });
  await expect(qr).toBeVisible();
  await qr.scrollIntoViewIfNeeded();
  const png = await qr.screenshot();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add contact' }).click();
  await page
    .getByLabel('Upload QR image')
    .setInputFiles({ name: 'contact.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByLabel('Contact to import')).toHaveValue(card);
  await page.getByRole('button', { name: 'Review contact' }).click();
  await page.getByRole('button', { name: 'Save reviewed contact' }).click();
  await page.getByLabel('Private message').fill('clear on idle');
  await page.clock.fastForward(301000);
  await expect(page.getByLabel('Private message')).toHaveCount(0);
  const base = page.url();
  await visitLink(page, base + '#' + card);
  await expect(page.getByLabel('Contact to import')).toHaveCount(0);
  await unlock(page);
  await expect(page.getByLabel('Contact to import')).toHaveValue(card);
  expect(new URL(page.url()).hash).toBe('');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('upgrading a v1 vault retains verified contacts and rejects wrong-recipient and tampered links', async ({
  page,
  baseURL,
}) => {
  const seed = 19;
  await mockPasskeys(page, seed);
  const { record, session } = await createVault(
    'Legacy profile',
    {
      id: Buffer.from([seed]).toString('base64url'),
      rp: new URL(baseURL!).hostname,
      input: Buffer.alloc(32).toString('base64url'),
    },
    new Uint8Array(32).fill(seed),
  );
  session.lock();
  const sender = await generateIdentity('Verified contact');
  const other = await generateIdentity('Different recipient');
  await page.route('**/v1-fixture.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Legacy storage fixture</title>',
    }),
  );
  await page.goto('./v1-fixture.html');
  await page.evaluate(
    ({ backup, contact }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('encrypt-this-identities-v1', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('vault').add(backup, 'identity');
          request.result
            .createObjectStore('contacts')
            .add({ contact, verified: true }, contact.id);
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
    { backup: backupText(record), contact: sender.contact },
  );
  await page.goto('./');
  await unlock(page);
  await openStoredContact(page, 'Verified contact');
  await expect(
    page
      .getByRole('region', { name: 'Conversation with Verified contact' })
      .getByText('Verified', { exact: true }),
  ).toBeVisible();

  const wrong = await encryptMessage(sender, other.contact, 'Wrong recipient');
  const valid = await encryptMessage(
    sender,
    record.contact,
    'Imported after upgrade',
  );
  const row = JSON.parse(Buffer.from(valid.slice(4), 'base64url').toString());
  const hex = Buffer.from(row.c, 'base64url');
  hex[0] ^= 1;
  row.c = hex.toString('base64url');
  const damaged =
    'em1.' + Buffer.from(JSON.stringify(row)).toString('base64url');

  async function paste(value: string) {
    await page.getByRole('button', { name: 'Open link', exact: true }).click();
    await page.getByLabel('Encrypted message to open').fill(value);
    await page
      .getByRole('button', { name: 'Open message', exact: true })
      .click();
  }
  await paste(wrong);
  await expect(page.getByRole('alert')).toContainText('different profile');
  await paste(damaged);
  await expect(page.getByRole('alert')).toContainText('authentication failed');
  await expect(page.getByTestId('identity-plaintext')).toHaveCount(0);
  await paste(valid);
  await expect(page.getByTestId('identity-plaintext')).toHaveText(
    'Imported after upgrade',
  );
});

test('a message that opens before setup can be imported after restoring its profile', async ({
  page,
  baseURL,
}) => {
  const seed = 20;
  await mockPasskeys(page, seed);
  const { record, session } = await createVault(
    'Restored profile',
    {
      id: Buffer.from([seed]).toString('base64url'),
      rp: new URL(baseURL!).hostname,
      input: Buffer.alloc(32).toString('base64url'),
    },
    new Uint8Array(32).fill(seed),
  );
  session.lock();
  const sender = await generateIdentity('Known sender');
  const message = await encryptMessage(
    sender,
    record.contact,
    'Preserved through setup',
  );
  await page.goto('./#' + message);
  await expect(page.getByText('A link is waiting')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open link', exact: true }),
  ).toHaveCount(0);
  await page
    .getByText('Backup, recovery & compatibility', { exact: true })
    .click();
  await page.getByLabel('Encrypted identity backup').fill(backupText(record));
  await page
    .getByRole('button', { name: 'Restore with passkey', exact: true })
    .click();
  await addCard(page, contactText(sender.contact), true);
  await expect(page.getByTestId('identity-plaintext')).toHaveText(
    'Preserved through setup',
  );
});

test('an archive write failure keeps the draft and allows retry', async ({
  page,
}) => {
  await mockPasskeys(page, 21);
  await page.goto('./');
  await createProfile(page, 'Storage failure');
  await addCard(page, await shareCard(page));
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (
      ...args: Parameters<typeof original>
    ) {
      const request = original.apply(this, args);
      if (this.name === 'messages') {
        IDBObjectStore.prototype.add = original;
        request.addEventListener('success', () => this.transaction.abort(), {
          once: true,
        });
      }
      return request;
    };
  });
  await page
    .getByLabel('Private message')
    .fill('Keep the draft after a failed write');
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not complete');
  await expect(page.getByLabel('Private message')).toHaveValue(
    'Keep the draft after a failed write',
  );
  await expect(page.getByLabel('Encrypted link')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(page.getByTestId('outgoing-message')).toHaveText(
    'Keep the draft after a failed write',
  );
});

test('another tab can update the transcript without extending idle unlock', async ({
  page,
  context,
}) => {
  const writer = await context.newPage();
  await mockPasskeys(page, 22);
  await mockPasskeys(writer, 22);
  await writer.goto('./');
  await createProfile(writer, 'Shared profile');
  await addCard(writer, await shareCard(writer));

  await page.clock.install();
  await page.goto('./');
  await unlock(page);
  await openStoredContact(page, 'Shared profile');
  await page.clock.fastForward(240000);
  await createLink(writer, 'New in another tab');
  await expect(page.getByTestId('outgoing-message')).toHaveText(
    'New in another tab',
  );
  await page.clock.fastForward(61000);
  await expect(
    page.getByRole('button', { name: 'Unlock with passkey' }),
  ).toBeVisible();
  await expect(page.getByTestId('outgoing-message')).toHaveCount(0);
});

for (const native of [false, true]) {
  test(
    native
      ? 'two contacts chat over a native WebRTC connection'
      : 'two contacts authenticate live codes and archive live messages',
    async ({ browser, baseURL, viewport }) => {
      test.skip(
        native && process.env.TEST_DIRECT_WEBRTC !== '1',
        'Requires direct UDP reachability between browser contexts.',
      );
      const first = await browser.newContext({ baseURL, viewport });
      const second = await browser.newContext({ baseURL, viewport });
      const alice = await first.newPage();
      const bob = await second.newPage();
      try {
        if (!native) await linkTestTransports(alice, bob);
        const externalRequests: string[] = [];
        for (const page of [alice, bob])
          page.on('request', (request) => {
            if (!request.url().startsWith(new URL(baseURL!).origin))
              externalRequests.push(request.url());
          });
        for (const [page, seed, name] of [
          [alice, 51, 'Alice'],
          [bob, 52, 'Bob'],
        ] as const) {
          await mockPasskeys(page, seed);
          await page.goto('./');
          await createProfile(page, name);
        }
        const aliceCard = await shareCard(alice);
        const bobCard = await shareCard(bob);
        await addCard(alice, bobCard);
        await addCard(bob, aliceCard);

        const button = (page: Page, name: string) =>
          page.getByRole('button', { name, exact: true });
        await button(alice, 'Live chat').click();
        await button(alice, 'Create invite').click();
        const offer = await alice
          .getByLabel('Invite code', { exact: true })
          .inputValue();
        await button(bob, 'Live chat').click();
        await bob.getByLabel('Paste invite code').fill(offer);
        await button(bob, 'Join live chat').click();
        const answer = await bob
          .getByLabel('Reply code', { exact: true })
          .inputValue();
        await alice.getByLabel('Paste reply code').fill(offer);
        await button(alice, 'Connect').click();
        await expect(alice.getByRole('alert')).toContainText('Wrong recipient');
        await alice.getByLabel('Paste reply code').fill(answer);
        await button(alice, 'Connect').click();
        for (const page of [alice, bob]) {
          await expect(button(page, 'Send live')).toBeVisible({
            timeout: 15000,
          });
          await expect(
            page.getByRole('region', { name: 'Live chat', exact: true }),
          ).toHaveCount(0);
        }
        await button(alice, 'Live chat').click();
        await expect(button(alice, 'End live chat')).toBeVisible();
        await button(alice, 'Done').click();

        await alice.getByLabel('Private message').fill('Live from Alice');
        await button(alice, 'Send live').click();
        await expect(bob.getByTestId('identity-plaintext')).toHaveText(
          'Live from Alice',
        );
        await bob.getByLabel('Private message').fill('Live from Bob');
        await button(bob, 'Send live').click();
        await expect(alice.getByTestId('identity-plaintext')).toHaveText(
          'Live from Bob',
        );
        expect(await localRecords(alice)).not.toContain('Live from Bob');
        await alice.evaluate(() => {
          const descriptor = Object.getOwnPropertyDescriptor(
            SubtleCrypto.prototype,
            'decrypt',
          )!;
          const decrypt: SubtleCrypto['decrypt'] = descriptor.value;
          Object.defineProperty(SubtleCrypto.prototype, 'decrypt', {
            ...descriptor,
            async value(
              this: SubtleCrypto,
              ...args: Parameters<SubtleCrypto['decrypt']>
            ) {
              Object.defineProperty(
                SubtleCrypto.prototype,
                'decrypt',
                descriptor,
              );
              const gate = new Promise<void>((resolve) =>
                window.addEventListener(
                  'release-test-decrypt',
                  () => resolve(),
                  { once: true },
                ),
              );
              document.documentElement.dataset.liveDecrypt = 'waiting';
              await gate;
              return decrypt.apply(this, args);
            },
          });
        });
        await bob.getByLabel('Private message').fill('Last live message');
        await button(bob, 'Send live').click();
        await expect(alice.locator('html')).toHaveAttribute(
          'data-live-decrypt',
          'waiting',
        );
        await button(bob, 'Lock').click();
        await expect(button(bob, 'Unlock with passkey')).toBeVisible();
        await expect(button(alice, 'Send live')).toHaveCount(0, {
          timeout: 15000,
        });
        await alice.evaluate(() =>
          window.dispatchEvent(new Event('release-test-decrypt')),
        );
        const incoming = ['Live from Bob', 'Last live message'];
        await expect(alice.getByTestId('identity-plaintext')).toHaveText(
          incoming,
        );
        await unlock(bob);
        await openStoredContact(bob, 'Alice');
        await button(bob, 'Live chat').click();
        await bob.getByLabel('Paste invite code').fill(offer);
        await button(bob, 'Join live chat').click();
        await expect(bob.getByRole('alert')).toContainText('already used');
        await alice.reload();
        await unlock(alice);
        await openStoredContact(alice, 'Bob');
        await expect(alice.getByTestId('identity-plaintext')).toHaveText(
          incoming,
        );
        await expect(alice.getByTestId('outgoing-message')).toHaveText(
          'Live from Alice',
        );
        expect(externalRequests).toEqual([]);
      } finally {
        await first.close();
        await second.close();
      }
    },
  );
}

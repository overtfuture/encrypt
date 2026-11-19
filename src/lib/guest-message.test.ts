import { describe, expect, it } from 'vitest';
import {
  openGuestMessage,
  parseGuestMessage,
  sealGuestMessage,
} from './guest-message';
import { generateIdentity } from './identity/messages';

describe('guest message formats', () => {
  it('opens links created with the original text-only format', async () => {
    const fragment =
      'eg1.GBgYGBgYGBgYGBgY.1XsRpGhhIyNk7lcsuYOd2hD00vTzKddktKNNgjhj6cf55YDXviS6WX8wqXz0yf3xLc7d';
    await expect(
      openGuestMessage(parseGuestMessage(fragment), 'DAwMDAwMDAwMDAwMDAwMDA'),
    ).resolves.toEqual({ message: 'A guest message from the old format' });
  });

  it('opens an attached contact and a message at the original size limit', async () => {
    const { contact } = await generateIdentity('Shared profile');
    const message = 'é'.repeat(2500);
    const { fragment, code } = await sealGuestMessage(message, contact);
    const envelope = parseGuestMessage(`${fragment}.${code}`);
    expect(envelope.code).toBe(code);
    await expect(openGuestMessage(envelope, code)).resolves.toEqual({
      message,
      contact,
    });
    await expect(sealGuestMessage(message + 'é', contact)).rejects.toThrow(
      '5,000',
    );
  });
});

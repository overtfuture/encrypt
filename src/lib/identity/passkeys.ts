import { decode, encode, random } from './encoding';
import type { Binding } from './vault';

type PRFResult = {
  prf?: { enabled?: boolean; results?: { first: ArrayBuffer } };
};
function extensions(input: string): AuthenticationExtensionsClientInputs {
  return {
    prf: { eval: { first: decode(input, 32) } },
  } as AuthenticationExtensionsClientInputs;
}
function result(
  credential: PublicKeyCredential,
): Uint8Array<ArrayBuffer> | undefined {
  const value = (credential.getClientExtensionResults() as PRFResult).prf
    ?.results?.first;
  if (!value) return;
  // Own the buffer: clearing our temporary secret must not mutate an extension's response.
  const bytes = new Uint8Array(value).slice();
  if (bytes.length !== 32) {
    bytes.fill(0);
    throw new Error('The passkey returned an invalid PRF result.');
  }
  return bytes;
}
function available() {
  if (!globalThis.isSecureContext || !navigator.credentials)
    throw new Error(
      'Passkeys require HTTPS or supported localhost and a compatible browser/provider.',
    );
}
export async function unlockPasskey(
  binding: Binding,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  available();
  if (binding.rp !== location.hostname)
    throw new Error(
      'This passkey belongs to a different app hostname. Use the original host or recovery.',
    );
  const credential = (await navigator.credentials.get({
    signal,
    publicKey: {
      challenge: random(32),
      rpId: binding.rp,
      allowCredentials: [{ type: 'public-key', id: decode(binding.id) }],
      userVerification: 'required',
      timeout: 60000,
      extensions: extensions(binding.input),
    },
  })) as PublicKeyCredential | null;
  if (!credential || encode(credential.rawId) !== binding.id)
    throw new Error('The selected passkey does not match this identity.');
  const bytes = result(credential);
  if (!bytes)
    throw new Error(
      'This passkey/provider did not return PRF output. Your encrypted identity is unchanged.',
    );
  return bytes;
}
export async function registerPasskey(
  name: string,
  signal?: AbortSignal,
): Promise<Binding> {
  available();
  const input = encode(random(32)),
    rp = location.hostname;
  const credential = (await navigator.credentials
    .create({
      signal,
      publicKey: {
        challenge: random(32),
        rp: { id: rp, name: 'Encrypt this' },
        user: {
          id: random(32),
          name: name || 'Local identity',
          displayName: name || 'Local identity',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: 60000,
        extensions: extensions(input),
      },
    })
    .catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === 'NotAllowedError')
        throw new Error(
          'Passkey creation did not finish. To use a security key, select it in the browser prompt and follow the PIN and touch instructions. If the prompt keeps failing in a private window, try a regular window.',
        );
      throw cause;
    })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey creation was cancelled.');
  return { id: encode(credential.rawId), rp, input };
}

export async function createPasskey(
  name: string,
  signal?: AbortSignal,
): Promise<{ binding: Binding; prf: Uint8Array<ArrayBuffer> }> {
  const binding = await registerPasskey(name, signal);
  // Enrollment must exercise the exact assertion path used after reload. Creation
  // output alone does not prove that the provider can unlock the saved vault.
  const prf = await unlockPasskey(binding, signal);
  return { binding, prf };
}

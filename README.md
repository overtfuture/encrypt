# encrypt this

A static SolidJS/TypeScript/Vite app for exchanging authenticated encrypted messages through shareable links or a direct WebRTC chat. Create a local profile with a compatible passkey and exchange public contact cards. Conversations are stored encrypted in this browser.

## Use

1. Select **Create profile with passkey**, then **Verify passkey** with the same credential. A display name is optional. Use a regular browser window if you want your local profile and chats to persist between visits.
2. Open **Profile** to export an encrypted identity backup. Optionally set up a recovery code, confirm it, and export a new backup. Keep the code separately. Backups restore the profile. Clearing browser data removes local contacts and chats.
3. Open **My contact** in the top bar to copy your public contact link or share a QR code. To add someone, review and save their card. Compare the full fingerprint over a trusted channel before marking the contact verified. Both contact statuses can exchange messages.
4. Select a contact, write a message, and choose **Create link**. Copy the link and send it through your own messaging app. For longer messages, share the encrypted text or file. Outgoing messages can be shared again from the conversation.
5. Open a received link, or use **Open link** to paste encrypted text or import a file. After passkey unlock, an authenticated message from a saved contact opens in that conversation. A link from an unknown sender waits for their contact card. Previously opened messages are available the next time you unlock this browser.

**Set an opening time** adds a cryptographic drand Quicknet timelock. Once the time passes, the recipient unlocks their profile, gets the public beacon using the link offered in the app, and pastes its JSON. Opening times are rounded up to a three-second release round. After the message is opened, its encrypted local history can be read again without the beacon.

The previous link/PIN workflow, Markdown rendering and automatic URL redirects have been removed at the owner’s request. Old payloads are no longer supported by this version. The prior implementation remains in Git history.

## Live chat

1. Both people unlock the app and save each other’s contact cards. Open the conversation and choose **Live chat**.
2. One person chooses **Create invite** and sends the encrypted code through a channel they already use. The other person pastes it into **Join live chat** and sends the reply code back.
3. The person who created the invite pastes the reply into the original tab and chooses **Connect**. Once connected, the setup panel closes and both people can use **Send live** in the conversation.

Live chat uses a text-only WebRTC data channel with manual signaling and an empty ICE server list. It requires direct network reachability, typically on the same network. Keep both tabs open and unlocked. Each tab supports one live chat, and locking or reloading ends the connection. Use encrypted links whenever a direct connection is unavailable or the recipient is offline. Your peer’s browser participates in direct network discovery and can learn network address information.

The default browser tests exercise the app flow with a test transport. On a host where browser contexts can establish a direct UDP connection, run the native smoke test with `TEST_DIRECT_WEBRTC=1 npm run test:e2e -- -g 'native WebRTC'`.

## Run and deploy

```sh
npm ci
npm run dev
npm test
npm run test:e2e
npm run format:check
npm run build
npm run test:production
npm run test:webkit
npm run preview
```

Node 24, HTTPS in production, and a browser/provider supporting WebAuthn PRF are required. Supported localhost is suitable for development. Tests use Google Chrome and Playwright WebKit; install them with `npx playwright install chrome webkit` if needed. TypeScript checking is part of `npm run build`; this repository has no separate lint configuration.

`dist/` is the complete static output. No backend/environment secrets are needed. Existing GitHub Pages CI/deployment is preserved. Set Pages source to GitHub Actions and deploy the default branch through the existing workflow.

For a project subpath:

```sh
PAGES_BASE_PATH=/encrypt/ npm run build
PAGES_BASE_PATH=/encrypt/ npm run test:production
```

Keep the hostname stable: it is the exact WebAuthn RP ID. Paths are not WebAuthn security boundaries; use a dedicated trusted origin rather than sharing an origin with untrusted apps. A different hostname requires recovery plus a new compatible passkey. Changing paths alone does not change the RP or origin-local vault.

The CSP is included in HTML for GitHub Pages. Where the host supports headers, also set `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. Keep HTML uncached/revalidated and use immutable hashed assets. Do not add third-party scripts. The CSP permits local assets, local QR workers, data/blob images, and inline styles used by the existing styling; it blocks remote scripts, frames, and application network destinations. Browsers ignore frame-ancestors in a meta CSP, hence the host-header recommendation.

## Recovery and limits

The passkey cryptographically unwraps a random local vault key through PRF and HKDF. Ordinary successful WebAuthn authentication is insufficient. Missing PRF output fails closed. Setup always performs an assertion after creation and uses that result for vault wrapping, matching the later unlock path. Creation-only PRF support is not accepted; the provider may prompt twice.

A synced passkey does **not** contain this app’s vault. Restore requires the encrypted backup plus either the original working passkey on the original hostname or the recovery code configured in that backup. Recovery creates a new passkey wrapper for the **same messaging identity**. It never silently generates a replacement identity. A new wrapper does not revoke older backups or their old passkey/recovery credentials. Restore will not overwrite a local identity. Concurrent writes use transactional compare-and-swap.

A page session locks after five minutes without pointer/keyboard activity, on page exit, or with **Lock**. Reload starts locked. Plaintext drafts, messages, recovery codes and key references are cleared where feasible, but JavaScript/browser memory erasure cannot be guaranteed. Clipboard contents and downloaded files are outside that clearing.

Messages are limited to 16,000 UTF-8 bytes. Contact names are at most 80 UTF-8 bytes. Ciphertext links are offered up to 8,000 characters. Larger messages use text or files. Contact QR payloads can be up to 800 characters. Contacts, verification and chat history are local to this browser and origin. The app deduplicates authenticated messages in the local archive. The pending list can hold up to 20 links per profile. Drafts stay in memory until you lock or reload.

## Security and validation

See [protocol and threat model](docs/identity-protocol.md) and [validation / manual compatibility matrix](docs/validation.md).

HPKE uses the maintained `@hpke/core@1.10.1` package (MIT), RFC 9180 Auth mode, P-256/HKDF-SHA256/AES-128-GCM. Selected-suite RFC vectors and real cryptographic round trips are tested. The library is not represented as independently audited; review its [upstream source](https://github.com/dajiaji/hpke-js) and [security policy](https://github.com/dajiaji/hpke-js/blob/main/SECURITY.md). The policy’s version table was stale relative to the installed release when checked. Timelocking reuses pinned `tlock-js@0.9.0` and `drand-client@1.2.5`, with pinned Quicknet parameters and signature verification.

This is not Signal-equivalent, forward-secret, post-quantum, or a production-security certification. Compromised recipient private keys expose recorded messages; compromised origin JavaScript or devices can access secrets while in use. Static hosting does not eliminate that risk. Public identity metadata, key IDs, opening rounds and ciphertext lengths may be visible. Fragments avoid ordinary HTTP payload transmission but can still appear in browser history, extensions, clipboard history and the app’s own scripts. Timed opening relies on drand’s threshold and availability assumptions; released data cannot be revoked or made to expire.

WebAuthn provider/OS networking is outside application control. Browser tests mock the WebAuthn boundary; they do not establish physical authenticator compatibility or cross-device recovery.

# Afterword

A small, client-side message-sharing site built with SolidJS, TypeScript, Tailwind CSS and Vite. Seal a text message, optionally set a secure opening time and PIN, then share a link or a downloadable QR code. Timed messages use drand's tlock library; message encryption and decryption stay in the browser.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Camera access and Web Crypto require HTTPS or localhost. To share with other people, deploy the production build to an HTTPS static host; localhost links only work on your own device.

```sh
npm test
npm run test:e2e
npm run build
npm run test:production
npm run preview
```

The browser tests use an installed Google Chrome, on desktop and mobile viewport profiles. `dist/` is the deployable static site; no backend, runtime environment variables, database or accounts are needed. Vite's default deployment target is the root of a domain. For a subpath, set the build-time `PAGES_BASE_PATH` (including a trailing slash), for example `PAGES_BASE_PATH=/encrypt/ npm run build`.

## GitHub Pages

The [CI and Pages workflow](.github/workflows/ci-pages.yml) runs on branch pushes and pull requests. It installs locked dependencies with Node.js 24, checks formatting, runs unit and browser tests, builds the site, and tests the production build. Only successful builds from the repository's default branch deploy. You can also run it manually from the Actions tab on the default branch. Live drand smoke tests remain opt-in; CI uses recorded, verified beacon fixtures.

After adding this project to your GitHub repository:

1. In **Settings → Pages → Build and deployment**, choose **GitHub Actions** as the source.
2. Push to the default branch, or run **CI and Pages** manually.
3. Open the deployment URL shown in the workflow's **github-pages** environment.

No personal access token or deployment secrets are needed. The workflow reads the configured Pages URL and automatically builds for its path, including `/encrypt/` project sites or the root of a custom domain. Share links and QR codes retain the hostname and path of the page where they were created. Custom domains must first be configured in Pages settings.

To verify a project-path build locally:

```sh
PAGES_BASE_PATH=/encrypt/ npm run build
PAGES_BASE_PATH=/encrypt/ npm run test:production
```

## Sharing and privacy

- Both QR codes and links contain the complete encrypted payload in a URL fragment (`#…`). Fragments are not sent in the normal HTTP request. The site makes no message-storage requests, loads its fonts locally, and stores no messages or PINs in localStorage.
- New dated messages use **drand Quicknet timelock encryption**. The random message key is encrypted to a future beacon round with `tlock-js`, using pinned Quicknet parameters. A verified signature for that exact round is required to decrypt. Advancing the clock or removing the countdown does not supply that signature. Encryption needs no network request; opening requests only public beacon data from fixed drand HTTPS relays. Your message, PIN and message key are not sent to drand.
- The countdown timestamp and beacon round are readable, authenticated metadata. The selected time is rounded **up** to Quicknet's next 3-second round, never down. The device clock controls the countdown and when the first unlock request is attempted; incorrect clocks can affect the display or delay requests but cannot create future beacon signatures.
- Without an opening date or PIN, the message key is included in the payload and anyone holding it can decrypt immediately. A dated message includes only the tlock-encrypted key; anyone holding it can decrypt after its beacon is released unless a PIN is also required.
- With a PIN, AES-256-GCM encrypts the message and separately wraps its random key with a PBKDF2-SHA256-derived key (600,000 iterations, random 16-byte salt). Random 12-byte IVs are used for both operations, and the version, date and protection mode are authenticated. The PIN is not included in the payload. Short numeric PINs can still be guessed offline; use longer codes and send them separately.
- PINs are 4–12 digits and retain leading zeroes. Forgotten PINs cannot be recovered. Messages cannot be revoked or changed after sharing, and recipients can retain revealed text.
- When both a date and PIN are selected, the PIN-wrapped key is itself encrypted with tlock. Both the released beacon and the correct PIN are required. Existing **version-1** links still open with their original behavior; legacy dated links show a notice that their countdown can be bypassed. They cannot be retroactively made secure by rebuilding the site.
- Timed opening depends on drand's security and availability. If a beacon is unavailable, the message stays sealed and the page retries after 10 seconds, then 30 seconds, then once per minute; a manual retry is also available. Each attempt tries up to four official relays with 5-second request timeouts. Only verified public beacons are cached in memory (up to 32 rounds), and requests/retries are canceled on reset or navigation. Once a beacon is published, it remains usable. A network shutdown before a target round could prevent unlocking; enough compromised participants could undermine the timing guarantee. See [drand's security assumptions](https://docs.drand.love/docs/timelock-encryption/).
- Cryptography code loads with the app before a countdown starts, so opening an already-loaded page does not depend on fetching a later JavaScript chunk. Clock corrections rearm the countdown/retry flow; a verified beacon is still required regardless of the displayed time.
- Text is limited to 16,000 UTF-8 bytes. QR capacity depends on the final URL and payload size. If it does not fit, the app preserves the share link. Very long links may be truncated by messaging apps or QR software.
- JavaScript running on the page can access the message and key. Use a trusted HTTPS host, review deployed code, and keep third-party scripts off the page. The hosting service can observe ordinary request metadata, but is not given the payload by this application.

## Opening messages

Follow a share link, paste a link or raw payload into **Open a message**, upload a QR image, or use a camera. No-PIN messages reveal automatically when their opening time arrives. PIN-protected messages require the sender's PIN after that time. QR decoding runs locally using a bundled worker.

Payloads are base64url-encoded JSON envelopes. Version 1 is retained for old links and new undated messages. Version 2 is used for new timed messages and includes the public UTC opening timestamp, Quicknet round, encrypted message and its IV, tlock-encrypted key package, and optional PIN salt/wrapping IV. Version, timestamp, PIN mode and round are authenticated by AES-GCM. Version-2 parsing rejects timestamps inconsistent with the round, unexpected chains/recipients, and unprotected-key replacements. Both versions reject unsupported versions, malformed encodings, invalid dates, incorrect key sizes and oversized inputs.

## Timelock verification

`npm test` uses recorded public Quicknet beacons with their real signatures and the real tlock/verification algorithms; transport responses are controlled so tests work offline. Browser tests do the same and cover countdowns, clock jumps, unavailable-beacon retries and legacy compatibility. Fixture beacons came from the official Quicknet relay for rounds 992, 1000 and 1001.

An opt-in live smoke test creates a short future message, waits for its actual public beacon, and decrypts it over the network:

```sh
LIVE_DRAND=1 npm test -- src/lib/timelock.live.test.ts
LIVE_DRAND=1 npm run test:production -- --grep "live future drand"
```

`tlock-js` and `drand-client` are distributed under Apache-2.0 OR MIT. Their MIT license notices are retained in [THIRD_PARTY_NOTICES.txt](public/THIRD_PARTY_NOTICES.txt), also included in the static build.

# Validation and manual compatibility matrix

Automated tests use real Web Crypto, HPKE, tlock, signature verification, IndexedDB and browser UI. Only the navigator.credentials boundary is substituted in the browser workflow tests. No physical passkey provider was validated in this implementation session.

Unit coverage includes authenticated two-way exchange, wrong recipient, substituted sender, corrupted ciphertext/vault, unknown formats/algorithms, oversize limits, private/public consistency on restore, recovery with a new wrapping secret, rejected old wrapping secrets, PRF absent on creation, follow-up assertion, missing PRF, wrong credential, cancellation, RP mismatch, fresh UV-required challenges, lock clearing, real historical beacon verification, and RFC Auth-suite vectors.

Browser coverage includes two isolated contexts, manual contact/message exchange and reply, page reload/lock, recovery with a different mocked credential, absence of plaintext draft/recovery code in persisted records, local contact QR decoding, consumed fragments, idle lock, bounded-input failures and storage corruption behavior. Production desktop and mobile profiles are Chromium. A separate suite now runs real Playwright WebKit/Web Crypto with mocked WebAuthn; it is not physical Safari/1Password validation.

## Automated results (2026-11-16)

| Command                                           | Result                                      |
| ------------------------------------------------- | ------------------------------------------- |
| npm run format:check                              | Passed                                      |
| npm test                                          | 9 tests passed, including RFC Auth vectors  |
| npm run test:e2e                                  | 16 desktop/mobile Chromium cases passed     |
| npm run build                                     | TypeScript and Vite passed                  |
| PAGES_BASE_PATH=/encrypt/ npm run build           | Passed                                      |
| PAGES_BASE_PATH=/encrypt/ npm run test:production | 16 cases passed against built static assets |
| git diff --check                                  | Passed                                      |

The repository has no separate lint command; formatting and strict TypeScript are its existing checks. No deployment or physical authenticator validation was performed. Expected forged-beacon tests can emit the dependency’s generic signature-validation diagnostic; no private material is logged. Review findings (storage-load corruption, lock during committed recovery writes, and oversized fragments) have regression coverage and were fixed.

## Manual matrix (not yet executed)

| Browser / provider                      | Create PRF identity | Lock / unlock | Export / same-host restore | Recovery + new passkey | Real camera QR |
| --------------------------------------- | ------------------- | ------------- | -------------------------- | ---------------------- | -------------- |
| Safari macOS / iCloud Keychain          | Untested            | Untested      | Untested                   | Untested               | Untested       |
| Safari iOS / iCloud Keychain            | Untested            | Untested      | Untested                   | Untested               | Untested       |
| Chromium macOS / platform provider      | Untested            | Untested      | Untested                   | Untested               | Untested       |
| Chromium / third-party password manager | Untested            | Untested      | Untested                   | Untested               | Untested       |
| Chromium / PRF-capable hardware key     | Untested            | Untested      | Untested                   | Untested               | Untested       |
| Safari / hardware key                   | Untested            | Untested      | Untested                   | Untested               | Untested       |

For each combination: create a new test identity, exchange fingerprints with an isolated second identity, encrypt/open/reply, lock/reload, cancel a prompt, try a missing/wrong credential, export a backup, restore on the original hostname with the original credential, configure/save recovery separately, restore using that backup/code and a new compatible credential, verify the fingerprint is unchanged and decrypt a message created before recovery. Test the provider’s creation-without-PRF-result path. Record OS/browser/provider/firmware versions and whether credentials synchronize. Test a no-PRF provider and confirm no unprotected vault is persisted. Do not label cross-device recovery supported until the exact combination passes.

For timed messages: choose a near-future date, export ciphertext, attempt before the round exists (including after advancing the device clock), obtain the public JSON separately after release, import it, reject a forged/wrong-round beacon, and open using the intended passkey identity. Existing automated fixtures verify real historical signatures; a live future-round/provider test remains manual.

Review network logs on the built static site: only local static assets should load. Clicking the explicit public beacon link opens a separate origin and communicates a public round number. Browser/OS passkey-provider traffic is outside the app’s control. Inspect IndexedDB, localStorage, sessionStorage and console for test plaintext, private scalars, vault keys, PRF outputs and recovery codes; no app logging contains these. Contact labels are public metadata.

No deployment was performed by this change. Host headers and real authenticator/cross-device paths remain unverified.

## Safari / 1Password follow-up

The user reported that a 1Password identity failed to unlock after reloading Safari on macOS, while a YubiKey identity could re-unlock. Exact versions and a reproducible provider trace are not available; the cause is not confirmed. No recovery code was configured. Preserve the existing passkey, site data and encrypted backup.

Enrollment now always obtains its wrapping secret through an assertion, rather than accepting a creation-only result. This is covered with a simulated provider returning different creation and assertion values and a real encrypted-vault restore. Missing assertion PRF blocks enrollment, and temporary secret cleanup leaves provider-owned buffers unchanged. Unlock errors distinguish absent PRF from failure to decrypt the vault wrapper.

These changes prevent the tested enrollment mismatch but do not establish that Safari/1Password is fixed or recover a vault whose original wrapping secret cannot be reproduced. The backup format and existing records are unchanged. Re-testing the affected identity on the updated app is still required.

## Confirmed WebKit restoration fix

The exact error from the user identified failure inside messaging-key restoration after the vault key had already been recovered. A real Playwright WebKit 27.2 reproduction failed reload/unlock with the old restore code. A focused Web Crypto probe then showed scalar-only P-256 PKCS#8 import throwing DataError while complete JWK import succeeded.

Restore now imports the complete JWK using the original encrypted scalar and authenticated public contact; existing backup formats and wrapping keys are unchanged. Fresh ephemeral ECDH agreement independently verifies that the private scalar matches the public contact. New identities must pass stored-bundle restoration before being returned for persistence. A regression also rejects mismatched keys even with a simulated permissive JWK importer.

After the fix, all 9 built-app WebKit tests passed, including reload/unlock, two-way messages, recovery and timed messages. CI now installs WebKit and runs npm run test:webkit against the production build. Real Safari/1Password re-testing by the user is still pending; physical provider compatibility is not inferred from mocked WebAuthn tests. The prior PRF-mismatch hypothesis is superseded for this reported error by the reproduced key-import failure.

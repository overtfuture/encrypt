# Afterword implementation

This records the initial version. New dated messages now use the secure drand implementation documented in [tlock-implementation.md](tlock-implementation.md); version-1 links retain the behavior below.

Approved direction: a static SolidJS + Tailwind app for short messages, optional device-clock unlock dates and optional PINs. Both direct links and QR codes must work. Date restrictions are a playful UI gate, not a cryptographic time lock.

- [x] Build and test versioned browser crypto payloads: AES-256-GCM message encryption, embedded random key without a PIN, PBKDF2-SHA256 (600,000 iterations) wrapped key with a PIN. Bind date and protection mode as authenticated metadata.
- [x] Build responsive create/share and open/reveal screens. Copy links, download QR images, paste payloads, upload QR images, and scan with a camera. Keep all payloads in URL fragments and all assets local.
- [x] Verify Unicode round trips, wrong/missing PINs, tampering, malformed input, dates, oversized QR behavior, direct links, automatic unlock, camera cleanup, and mobile layout. Run unit tests, browser tests, and the production build.

Links may hold larger messages than QR codes; QR generation failure must preserve the working link. Never persist plaintext or PINs in browser storage. Camera access requires HTTPS or localhost; stop tracks when leaving the scanner. Opening a new payload cancels any pending decryption of the old one.

Verification: 10 unit tests and 26 desktop/mobile Chromium browser tests pass. TypeScript checking, the production build, and Prettier checking pass. Camera startup/cleanup uses Chrome's synthetic camera; a physical phone camera and Safari have not been tested. Independent code review identified fragment reset synchronization and late scanner completion bugs; both were reproduced in failing browser tests, fixed, and verified in the full suite. Deployment is not part of this local implementation.

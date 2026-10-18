# Secure timed messages

User-approved change: new messages with an opening date use drand's tlock library for enforced time-based decryption. Keep the existing local countdown, PIN option, QR codes and direct links. The countdown timestamp is public metadata; the message and decryption key remain encrypted.

- [x] Add a Quicknet integration with pinned chain information, signature verification, explicit-round HTTPS requests, relay fallback, bounded requests, and in-memory caching of verified public beacons. Creation uses public parameters locally. Choose the first round at or after the requested time, never the previous round.
- [x] Use version 2 for new dated payloads. Authenticate the public version/date/PIN mode/round. Encrypt the AES message key (or PIN-wrapped key) with tlock. Keep version-1 decoding and undated creation compatible. Validate envelopes before decryption; never accept raw-key fallback for version 2.
- [x] Keep the countdown local. At zero, request the public unlock beacon; show a recoverable waiting state if unavailable. Retry with backoff and a manual retry action. Abort requests and cancel retries on reset/navigation. Preserve the PIN requirement after time unlock. Identify legacy dated messages as countdown-only.
- [x] Update privacy/dependency copy and README. Test released-beacon decryption with the real library, spoofed clock and tampering failures, round rounding, invalid signatures, relay/network recovery, cancellation, PIN layering, legacy fixtures, and the UI. Run a live short future-round smoke test, the complete unit/browser suites and production build.

Defaults: Quicknet chain `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`; 3-second rounds. Only fixed public drand relays may be contacted, with no message/PIN/key in requests. Keep metadata readable for countdowns and verify it against the encrypted package. Preserve all existing links; their original security properties cannot be upgraded retroactively. No deployment in this change.

Verified on 2026-10-18:

- Unit tests: 19 passed; the separate opt-in live future-round test also passed.
- Development browser suite: 42 passed across desktop and mobile Chrome viewports; 2 opt-in live tests skipped in the default run.
- Production browser suite with live drand enabled: 18 passed, including real future-round unlocks in both viewports.
- TypeScript, production build, and formatting checks passed.
- Independent review fixes have regression coverage: crypto loads before the countdown, and correcting the device clock backwards rearms automatic opening.

The local preview remains available; no deployment was performed. Physical camera scanning and Safari were not tested.

# Passkey identities implementation plan

Goal: implement the supplied passkey identities/no-relay specification in the existing Solid/Vite static app.

Architecture: separate bounded serialization, HPKE authenticated messaging, WebAuthn PRF adapter, encrypted vault, IndexedDB persistence, and manual sharing UI. Owner follow-up explicitly removes the legacy workflow; optional date-based opening is retained only for new passkey messages. No message history. Hostname-scoped RP, five-minute idle lock. Imported contact keys are immutable; changed keys require reviewing and saving a separate contact.

Assumptions: one local identity per browser origin; restore into an empty vault only (no destructive replacement). Recovery rewraps the original identity. Timed passkey messages wrap the HPKE envelope with tlock and use manually imported verified public beacons; no application beacon fetches. No ciphertext QR initially; contact QR only, maximum 800 characters. Link limit 8,000 characters; message text 16,000 UTF-8 bytes.

- [x] Add regression/lifecycle tests; run existing legacy tests before behavior changes.
- [x] Implement `src/lib/identity/{encoding,messages,passkeys,vault,storage}.ts`: strict formats, pinned public contacts, HPKE Auth, encrypted private bundle and vault key wrapping, recovery verification, transactional create-only persistence.
- [x] Add `src/components/IdentityMessages.tsx`, reuse existing styles, add app navigation, fragment routing and consumption, clear session/UI on lock and page exit. Explicit copy/export only.
- [x] Replace timed beacon fetches with bounded verified import; remove obsolete legacy fixtures/tests and test new timed envelopes; restrict CSP and document static host headers.
- [x] Add built-browser tests for two identities, restore/recovery, persistence, lock, QR scan, and no external requests. Separate mocked PRF from hardware validation.
- [x] Run unit tests, typecheck/build, formatting, new browser suites, subpath production tests. Document threat model, protocol, provenance, compatibility matrix and outstanding review.

Review focus: async operations finishing after lock, simultaneous tabs creating an identity, corrupted backup preserving existing state, imported contact substitution, credential PRF support without creation output. Test these at the owning boundary.

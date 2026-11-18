# Identity and envelope implementation

## Boundaries

- `identity/encoding.ts`: bounded canonical unpadded base64url, UTF-8, exact field sets, portable fragment links.
- `identity/messages.ts`: HPKE Auth, contacts, message framing, optional timed outer envelope.
- `identity/passkeys.ts`: local UV-required ceremonies, fresh 32-byte challenges, selected-credential PRF, no account authentication server.
- `identity/vault.ts`: encrypted private bundle, passkey/recovery wrapping and verified rewrap.
- `identity/storage.ts`: IndexedDB atomic writes, pinned contacts, pending links, and history queries.
- `identity/history.ts`: dedicated history key derivation, authenticated encryption for local transcripts, and payload validation.
- `identity/live-chat.ts`: manually exchanged encrypted signaling, a direct WebRTC data channel, and connection lifecycle.
- `IdentityMessages.tsx`: passkey gate, manual import/export, and session lifecycle.
- `timelock.ts`: pinned drand Quicknet parameters, local encryption and explicitly imported, verified beacons.

Manual sharing and live transport use the same message envelopes and encrypted archive.

## Formats

All portable values are an ASCII prefix followed by unpadded base64url of UTF-8 JSON. Unknown fields, versions and algorithms fail. Binary fields require canonical encoding and exact sizes where defined. Limits are checked before JSON parsing; no compression/decompression is used. No authentication failure falls back to another format. Incoming URL fragments are consumed without putting their content into queries or paths.

| Prefix | Contents                      | Maximum portable characters |
| ------ | ----------------------------- | --------------------------- |
| ec1.   | Public contact `{v,a,n,k,id}` | 800                         |
| em1.   | HPKE Auth `{v,a,r,s,m,t,e,c}` | 31,000                      |
| et1.   | Timelock `{v,t,k}`            | 85,000                      |
| ev1.   | Encrypted identity backup     | 12,000                      |
| el1.   | Encrypted live signaling      | 31,000                      |

All v fields equal 1. Algorithm string is exactly `P256-SHA256-A128GCM-Auth`. Contact `k` is the 65-byte SEC1 uncompressed P-256 key, `id` its full SHA-256 digest, and `n` the optional display label (0–80 UTF-8 bytes). Import validates the point via Web Crypto and recomputes the fingerprint. Contacts are keyed by full fingerprint; same-name changed keys show a warning and require explicit save as a separate unverified contact. There is no automatic key replacement. Verified status records the user’s out-of-band comparison, not an application certification. Backups currently cover the identity, not the contact address book.

Message `r`/`s` are recipient/sender key IDs; `m` is a fresh random 16-byte message ID; `t` is null or the integer Quicknet round. `e` is the 65-byte HPKE encapsulation; `c` is ciphertext (17–16,016 bytes). Each message gets an independent library-managed sender context; no context or nonce is reused across manual messages.

HPKE info and AAD are identical UTF-8 JSON arrays in this exact order:

```text
["encrypt-this/message",1,"P256-SHA256-A128GCM-Auth",r,s,m,t]
```

Auth mode is selected by always supplying the local messaging private key as senderKey and the separately pinned contact public key as senderPublicKey. No sender public key from the message is trusted. Sender authentication is subject to RFC 9180’s key-compromise impersonation limits: a compromised recipient key defeats the corresponding assurances. It is not a signature for third-party nonrepudiation.

Live invites and replies use the same envelope framing with a null opening round and a separate `encrypt-this/live-signal` HPKE context. Their encrypted JSON includes a random session ID, expiration, role, and data-only SDP with gathered ICE candidates and DTLS fingerprint. A reply must match the exact open invite. A live data channel carries ordinary untimed authenticated message envelopes so archive deduplication applies across both transports. The peer connection uses no configured ICE servers and the application exchanges no SDP over HTTP. The browser verifies the DTLS fingerprint from the authenticated SDP.

A timed message encrypts the complete em1 string with the established tlock construction for round `t`. et1 carries only version, round and ASCII-armored tlock ciphertext (max 62,000 characters). Parsing pins the Quicknet chain and single tlock recipient, bounds the armored data, and verifies the imported beacon signature. After opening, inner and outer rounds must match; the inner round is also bound by HPKE authentication. This is composition of existing HPKE and tlock implementations, not a custom public-key primitive. The outer date is untrusted until inner authentication succeeds. Possession of a public beacon reveals only the HPKE envelope, not its plaintext.

## Vault and recovery

Generate independent random P-256 messaging keys and a random 32-byte vault key. Serialize the private scalar as 32 bytes and AES-256-GCM encrypt it under the vault key, using a random 12-byte nonce. Bundle AAD is UTF-8 `encrypt-this/vault/v1/bundle/` followed by the complete serialized public contact.

A selected WebAuthn credential evaluates a random 32-byte PRF input. Enrollment always obtains this value through a subsequent assertion, even if creation returned PRF output, so wrapping uses the same ceremony path as later unlock. Temporary PRF buffers are owned copies; cleanup does not mutate provider response objects. HKDF-SHA256 uses a random 32-byte salt and info `encrypt-this/vault/v1/passkey/wrap` to derive an AES-256-GCM wrapping key. Its random 12-byte nonce and AAD bind the purpose, full messaging key ID, credential ID, exact RP hostname and PRF input. Only the 48-byte wrapped vault key and nonsecret metadata are persisted alongside the encrypted bundle.

Recovery uses a random 32-byte code encoded as 43 base64url characters. It independently wraps the same vault key with HKDF info `encrypt-this/vault/v1/recovery/wrap`, a separate random salt and nonce, and AAD binding purpose and full messaging key ID. The code is never persisted. Setup decrypts the resulting wrapper/bundle as a self-test, then requires re-entry of the saved code before persisting. Rewrapping with a newly created passkey verifies the new wrapper by unlocking and checking the private/public relationship before saving.

Backups contain v, contact, binding, bundle, passkey wrapper and optional recovery wrapper. They never contain the raw private scalar, raw vault key, PRF output or recovery code. Imported backups are structurally checked, decrypted and their public/private relationship checked before a create-only save. Restore reconstructs a complete P-256 JWK from the encrypted scalar and authenticated public contact because WebKit rejects scalar-only PKCS#8 import. A fresh ephemeral ECDH agreement in both directions checks the scalar/public-point relationship independently of JWK metadata. New identity creation exercises this same restore path before allowing persistence. Existing vault changes compare against the prior serialized record inside one IndexedDB transaction. A stale or competing writer cannot silently replace it. An existing record cannot be replaced through import.

The app derives a non-extractable AES-256-GCM history key from the unlocked vault key with HKDF-SHA256, the full owner fingerprint as salt, and the context `encrypt-this/history/v1`. Each row uses a random 12-byte nonce. Authenticated metadata binds the format, owner, contact, direction, message ID, local timestamp, optional opening round, and optional incoming payload digest. The encrypted data holds the message body and, for outgoing messages, the share payload. Conversation indexes and routing metadata are visible in IndexedDB.

IndexedDB v2 adds history and pending stores with an in-place migration. A message is archived after HPKE authentication, and the transaction removes the pending ciphertext while enforcing one history entry per owner, contact, direction and message ID. Pending entries carry the original encrypted envelope. The active tab can stage links in session storage before unlock. Decrypted messages and drafts live in memory. Plaintext buffers are zeroed when feasible and key references are dropped on lock. The browser, garbage collector, provider and OS can retain copies beyond application control.

## Threat model and provenance

Protect against theft of locked browser storage without its PRF credential or recovery code, accidental disclosure through the manual transport, tampered ciphertext and impersonation using an unrelated sender key. Do not protect against malicious origin code, XSS/extension/device compromise while unlocked, copied recovery codes/backups, a compromised drand threshold, or compelled/compromised passkey providers. Contact trust is only as strong as the out-of-band comparison and local device integrity.

Dependencies are bundled locally. No remote scripts, fonts, QR services, telemetry or message uploads are configured. Public-beacon navigation is an explicit external link initiated by the user, not an application fetch. Neither public key metadata nor lengths are necessarily hidden. There is no forward secrecy, sender anonymity guarantee, universal replay protection, revocation, forced expiry, or cross-device sync.

Reference sources:

- [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html), Auth mode and security considerations.
- [hpke-js](https://github.com/dajiaji/hpke-js), installed @hpke/core 1.10.1 and lockfile-pinned @hpke/common. Source/types confirm senderKey/senderPublicKey Auth support. No independent audit claim.
- [CFRG vectors](https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/master/test-vectors.json): fixture selects mode 2, KEM 16, KDF 1, AEAD 1, first three encryptions. Test-only ephemeral input is never used in application encryption.
- [WebAuthn PRF](https://w3c.github.io/webauthn/#prf-extension): actual output is mandatory; creation may need a subsequent assertion.
- [drand timelock assumptions](https://docs.drand.love/docs/timelock-encryption/).

Further review is required for the overall integration, dependency updates/supply chain, host headers and deploy trust, authenticator behavior, accessibility and real-device QR scanning. Passing tests is not a production-security or independent-audit claim.

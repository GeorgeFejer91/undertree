# Authentication, Authorization, and Trusted Browsers

Use this reference whenever a human password, invitation, remembered browser, grant, or revocation path is involved.

## Separate the Security Questions

Answer each independently:

1. How does a browser discover a possible native target?
2. How do both endpoints authenticate one another?
3. How is a fresh session key established?
4. Which roles/scopes does Rust authorize?
5. How is a browser remembered without retaining the password?
6. How are access and active sessions revoked?
7. What metadata remains visible to signaling/relay infrastructure?

Transport encryption alone answers none of the authorization questions.

## High-Entropy Invitations

BRSP/1 mutual HMAC proof is appropriate when the invitation secret is generated from operating-system randomness with at least 192 bits, transferred out of band, short-lived, and never reused as a human password.

Both sides exchange fresh nonces and sign a canonical role-bound transcript. Derive independent keys for proof, control authentication/encryption if needed, routing, and media rather than reusing one secret everywhere.

## Human Passwords Require a PAKE

For a password a person can remember or type, use a maintained implementation of a reviewed password-authenticated key exchange:

- **OPAQUE (RFC 9807)** for an augmented client/server model where the native authority holds a registration record and should not learn the password during login;
- **SPAKE2+ (RFC 9383)** for an augmented verifier model when an interoperable implementation fits;
- **SPAKE2 (RFC 9382)** for a symmetric pairing model when both endpoints legitimately know the password-derived secret.

The exact choice depends on library maturity, platform support, registration/reset UX, and deployment model. Pin the suite and protocol identifier. Use published vectors and cross-language interoperability tests.

Do not design `proof = HMAC(PBKDF2(password), public transcript)` and present it as a safe password protocol. A captured exchange can enable offline guessing unless the complete protocol was designed to prevent it. A memory-hard KDF protects stored verifier material but does not turn an ad-hoc challenge response into a PAKE.

## Password Storage and Attempts

- Normalize password input only according to an explicit profile; avoid invisible transformations that make recovery impossible.
- Keep plaintext out of logs, URLs, analytics, command lines, crash reports, browser storage, and long-lived JavaScript state.
- Store only the standardized PAKE registration/verifier material and required parameters.
- If a separate local password hash is required, use a tuned Argon2id implementation with unique random salt and versioned parameters; benchmark on supported hardware.
- Rate-limit online attempts by target/session and introduce capped delays without making a trivial unauthenticated memory/CPU DoS.
- Use indistinguishable public failure responses where target/account enumeration matters.
- Password change increments the authentication generation and revokes device records, grants, sessions, and cached discovery material.

## Discovery Without Secret Leakage

A password-derived room name is at most a rendezvous hint. It may permit offline enumeration or correlation and must not grant control. Prefer a design where discovery yields a fresh random private route only after the password protocol reaches the appropriate stage.

Never place passwords, grants, bearer tokens, or long-lived private routes in a query string. URL fragments avoid HTTP transmission but remain visible to page script and browser history until removed; use them only for short bootstrap material and clear them immediately.

## Rust-Owned Grant

After authentication, Rust issues an opaque grant record containing at least:

```text
grant_id
principal_id
device_id (optional for one-time invitation)
peer_binding
role
scopes
authority_generation
authentication_generation
issued_at / expires_at
last_sequence or replay window
revoked_at / reason
```

The wire token can be opaque. Do not rely on client-readable claims without server-side verification. Check the record on every command and transfer operation. Role switches should create a new scoped grant or reauthorize explicitly; `upload` must not silently become `control`.

## Revocable 24-Hour Browser Access

Treat “remember this browser for 24 hours” as device authorization, not a 24-hour copy of the password.

### Preferred proof-of-possession profile

1. After a successful password PAKE, the browser generates an asymmetric signing key with WebCrypto and marks the private key non-extractable.
2. Store the `CryptoKey` in IndexedDB. Send only the public key, display name, requested role/scopes, and an authenticated enrollment proof.
3. Rust creates a random device ID and stores the public key, scopes, creation time, hard expiry no later than 24 hours, auth generation, and revocation state.
4. On reconnect, Rust sends a fresh random challenge bound to protocol, target, authority/auth generations, device ID, requested role/scopes, and expiry.
5. The browser signs the canonical challenge. Rust validates the signature, freshness, origin/session context where available, device record, expiry, and revocation before issuing a short-lived session grant.
6. Every challenge is single-use and expires quickly. A session grant should normally expire sooner than the device record.

This follows the same sender-constraining principle as proof-of-possession token designs without claiming OAuth DPoP conformance. If using DPoP itself, implement its complete HTTP/JWT profile rather than borrowing the name.

### Browser-key limitations

WebCrypto makes `CryptoKey` serializable and supports non-extractable keys in IndexedDB, but it does not guarantee hardware storage or protection from same-origin script. XSS at the companion origin can ask the key to sign. Therefore:

- host only static pinned assets;
- use a restrictive CSP and no arbitrary third-party scripts;
- prevent framing where appropriate;
- keep service-worker scope narrow and update deliberately;
- bind device records to the exact origin/product;
- expose a local device list and immediate revoke/forget action;
- handle cleared storage as re-pairing, not account loss.

### Bearer fallback

If a supported browser cannot persist the required key, a random 256-bit opaque bearer credential may be stored for at most 24 hours. Label this weaker because theft permits replay. Bind it server-side to role/scopes, device record, auth generation, and expiry; rotate it on use when practical; never put it in URLs or logs.

## Session Key and Message Binding

A PAKE produces authenticated key material. Derive purpose-separated keys using the protocol's specified KDF context. Bind subsequent grants and channel setup to the completed transcript. If application messages rely solely on WebRTC DTLS/TLS for integrity, still bind the authenticated principal to the exact peer/connection and reject peer replacement until it reauthenticates.

## Revocation Events

Support:

- forget this browser;
- revoke one named browser locally;
- revoke all browsers;
- password change/security reset;
- grant/session expiry;
- authority restart/rotation;
- suspicious replay or key mismatch.

Revocation closes affected lanes, rejects queued work, aborts incomplete transfers, releases leases, and publishes a safe local status. Completed committed files or actions are not rolled back unless the domain transaction says so.

## Required Negative Tests

- wrong password and captured-transcript replay;
- reflected role/proof and nonce reuse;
- unknown/expired/revoked device;
- valid device signature for changed scope, target, generation, or nonce;
- stolen bearer credential after rotation/revoke;
- peer ID changes without reauthentication;
- role escalation and cross-mode grant reuse;
- password change during active control/upload;
- old grant after authority restart;
- clock skew around expiry using the Rust clock as authority;
- malformed keys/signatures and oversized auth messages;
- same-origin compromise assumptions documented as residual risk.

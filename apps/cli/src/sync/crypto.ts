/**
 * Encryption envelope for sync journal entries.
 *
 * Pure functions on a 32-byte master key (`Kx`). Tier 5b owns this module;
 * Tier 5c will load `Kx` from a keychain wrapper and pass it in. Tests pass
 * `Kx` directly so nothing here touches storage or the network.
 *
 * Algorithm (matches `docs/docs-temp/SYNC-PROTOCOL.md` §3):
 *   - Recipient static public key is derived from `Kx` via SHA256 + X25519
 *   - Each envelope generates a fresh ephemeral X25519 keypair
 *   - Shared secret = X25519(ephemeral.priv, derive_pub(Kx))
 *   - AEAD = XChaCha20-Poly1305 with 24-byte random nonce
 *   - Envelope = { v: 1, e: ephemeral.pub, n: nonce, c: ciphertext+tag } in base64
 *
 * Anyone holding `Kx` can decrypt. The relay holds neither `Kx` nor
 * `derive_pub(Kx)` so it sees only opaque ciphertext.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import type { ScopeKind } from '../types/index.js';

/** Domain separators - distinct strings prevent cross-protocol key reuse. */
const DOMAIN_USER_HASH = 'lumen-relay-routing';
const DOMAIN_ENCRYPTION_PUB = 'lumen-encryption-pub';
const DOMAIN_FINGERPRINT = 'lumen-key-fingerprint';

/** Byte sizes the rest of the module relies on. */
export const MASTER_KEY_BYTES = 32;
export const X25519_SCALAR_BYTES = 32;
export const X25519_POINT_BYTES = 32;
export const XCHACHA_NONCE_BYTES = 24;
export const USER_HASH_HEX_LENGTH = 16;
export const SCOPE_TAG_HEX_LENGTH = 16;

/**
 * Versioned envelope. Stable wire format - the relay stores blobs in this
 * shape, devices send/receive them. `v` is the format version; bump on
 * any breaking change to the algorithm.
 */
export type EncryptionEnvelope = {
    v: 1;
    /** Base64-encoded ephemeral X25519 public key (32 bytes). */
    e: string;
    /** Base64-encoded XChaCha20 nonce (24 bytes). */
    n: string;
    /** Base64-encoded ciphertext + 16-byte AEAD tag. */
    c: string;
};

/** Generate a fresh 32-byte master key. */
export function generateMasterKey(): Buffer {
    return randomBytes(MASTER_KEY_BYTES);
}

/**
 * Derive the relay routing key. One-way function on `Kx`. Two devices with
 * the same `Kx` produce the same hash; different keys produce different
 * hashes. Truncated to 16 hex chars (~64 bits) by design - we only need
 * enough entropy to disambiguate users on the relay; pre-image resistance
 * isn't a goal because the input is already a random 32-byte secret.
 */
export function deriveUserHash(masterKey: Buffer): string {
    requireMasterKey(masterKey);
    return createHash('sha256')
        .update(masterKey)
        .update(DOMAIN_USER_HASH)
        .digest('hex')
        .slice(0, USER_HASH_HEX_LENGTH);
}

/**
 * Derive a per-scope routing tag the relay can index without seeing the
 * scope identity. HMAC keyed by `Kx`, message = "kind:key". Same scope on
 * the same `Kx` always produces the same tag (so peer devices can pull
 * filtered batches); different scopes or different keys diverge.
 */
export function deriveScopeRoutingTag(
    masterKey: Buffer,
    scope: { kind: ScopeKind; key: string },
): string {
    requireMasterKey(masterKey);
    const message = `${scope.kind}:${scope.key}`;
    return createHmac('sha256', masterKey)
        .update(message)
        .digest('hex')
        .slice(0, SCOPE_TAG_HEX_LENGTH);
}

/**
 * Stable fingerprint for `sync_state.encryption_key_fingerprint`. Used as
 * a sanity check that two devices think they share the same key. Short
 * by design (16 hex chars) - it's user-readable, not security-critical.
 */
export function fingerprintMasterKey(masterKey: Buffer): string {
    requireMasterKey(masterKey);
    return createHash('sha256')
        .update(masterKey)
        .update(DOMAIN_FINGERPRINT)
        .digest('hex')
        .slice(0, 16);
}

/**
 * Derive the recipient's static X25519 keypair from `Kx`. The private
 * scalar is `SHA256(Kx || DOMAIN_ENCRYPTION_PUB)`. Both sides of a sync
 * peer derive the same keypair from the same `Kx`, so the relay never
 * needs the public key - it just stores opaque envelopes.
 */
function deriveRecipientKeypair(masterKey: Buffer): {
    priv: Uint8Array;
    pub: Uint8Array;
} {
    const scalar = createHash('sha256').update(masterKey).update(DOMAIN_ENCRYPTION_PUB).digest();
    const priv = new Uint8Array(scalar);
    const pub = x25519.getPublicKey(priv);
    return { priv, pub };
}

/**
 * Encrypt a plaintext payload (JSON string) into a versioned envelope.
 * Generates a fresh ephemeral keypair each call - never reuses the
 * shared secret or nonce, even on the same `Kx`.
 */
export function encryptEnvelope(plaintext: string, masterKey: Buffer): EncryptionEnvelope {
    requireMasterKey(masterKey);

    const recipient = deriveRecipientKeypair(masterKey);
    const ephemeralPriv = randomBytes(X25519_SCALAR_BYTES);
    const ephemeralPub = x25519.getPublicKey(new Uint8Array(ephemeralPriv));
    const shared = x25519.getSharedSecret(new Uint8Array(ephemeralPriv), recipient.pub);

    const nonce = randomBytes(XCHACHA_NONCE_BYTES);
    const aead = xchacha20poly1305(shared, new Uint8Array(nonce));
    const ciphertext = aead.encrypt(new TextEncoder().encode(plaintext));

    return {
        v: 1,
        e: Buffer.from(ephemeralPub).toString('base64'),
        n: nonce.toString('base64'),
        c: Buffer.from(ciphertext).toString('base64'),
    };
}

/**
 * Decrypt a sealed envelope back to its plaintext. Throws on:
 *   - AEAD tag mismatch (tampered ciphertext)
 *   - Wrong master key
 *   - Malformed envelope (wrong base64 or wrong sizes)
 *   - Unsupported version
 */
export function decryptEnvelope(envelope: EncryptionEnvelope, masterKey: Buffer): string {
    requireMasterKey(masterKey);
    if (envelope.v !== 1) {
        throw new Error(`unsupported envelope version: ${String(envelope.v)}`);
    }

    const ephemeralPub = Buffer.from(envelope.e, 'base64');
    const nonce = Buffer.from(envelope.n, 'base64');
    const ciphertext = Buffer.from(envelope.c, 'base64');

    if (ephemeralPub.length !== X25519_POINT_BYTES) {
        throw new Error(`envelope.e wrong size: expected ${X25519_POINT_BYTES} bytes`);
    }
    if (nonce.length !== XCHACHA_NONCE_BYTES) {
        throw new Error(`envelope.n wrong size: expected ${XCHACHA_NONCE_BYTES} bytes`);
    }

    const recipient = deriveRecipientKeypair(masterKey);
    const shared = x25519.getSharedSecret(recipient.priv, new Uint8Array(ephemeralPub));

    const aead = xchacha20poly1305(shared, new Uint8Array(nonce));
    const plaintext = aead.decrypt(new Uint8Array(ciphertext));

    return new TextDecoder().decode(plaintext);
}

function requireMasterKey(masterKey: Buffer): void {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== MASTER_KEY_BYTES) {
        throw new Error(
            `master key must be a Buffer of ${MASTER_KEY_BYTES} bytes (got ${
                Buffer.isBuffer(masterKey) ? `${masterKey.length} bytes` : typeof masterKey
            })`,
        );
    }
}

import { describe, it, expect } from 'vitest';
import {
    generateMasterKey,
    deriveUserHash,
    deriveScopeRoutingTag,
    fingerprintMasterKey,
    encryptEnvelope,
    decryptEnvelope,
    MASTER_KEY_BYTES,
    USER_HASH_HEX_LENGTH,
    SCOPE_TAG_HEX_LENGTH,
} from '../src/sync/index.js';
import type { EncryptionEnvelope } from '../src/sync/index.js';

/** ─── Master key generation ─── */

describe('generateMasterKey', () => {
    it('returns a 32-byte Buffer', () => {
        const k = generateMasterKey();
        expect(Buffer.isBuffer(k)).toBe(true);
        expect(k.length).toBe(MASTER_KEY_BYTES);
    });

    it('produces different keys on each call (high entropy)', () => {
        const a = generateMasterKey();
        const b = generateMasterKey();
        expect(a.equals(b)).toBe(false);
    });
});

/** ─── deriveUserHash ─── */

describe('deriveUserHash', () => {
    it('returns 16 hex chars', () => {
        const k = generateMasterKey();
        const hash = deriveUserHash(k);
        expect(hash).toMatch(new RegExp(`^[a-f0-9]{${USER_HASH_HEX_LENGTH}}$`));
    });

    it('is deterministic — same key produces same hash', () => {
        const k = generateMasterKey();
        expect(deriveUserHash(k)).toBe(deriveUserHash(k));
    });

    it('is key-isolated — different keys produce different hashes', () => {
        const a = generateMasterKey();
        const b = generateMasterKey();
        expect(deriveUserHash(a)).not.toBe(deriveUserHash(b));
    });

    it('rejects keys of the wrong size', () => {
        expect(() => deriveUserHash(Buffer.alloc(16))).toThrow(/master key must be a Buffer of 32/);
    });
});

/** ─── deriveScopeRoutingTag ─── */

describe('deriveScopeRoutingTag', () => {
    it('returns 16 hex chars', () => {
        const k = generateMasterKey();
        const tag = deriveScopeRoutingTag(k, { kind: 'codebase', key: 'repo-a' });
        expect(tag).toMatch(new RegExp(`^[a-f0-9]{${SCOPE_TAG_HEX_LENGTH}}$`));
    });

    it('is deterministic per (key, scope) pair', () => {
        const k = generateMasterKey();
        const a = deriveScopeRoutingTag(k, { kind: 'codebase', key: 'repo-x' });
        const b = deriveScopeRoutingTag(k, { kind: 'codebase', key: 'repo-x' });
        expect(a).toBe(b);
    });

    it('different scopes (same key) produce different tags', () => {
        const k = generateMasterKey();
        const a = deriveScopeRoutingTag(k, { kind: 'codebase', key: 'repo-a' });
        const b = deriveScopeRoutingTag(k, { kind: 'codebase', key: 'repo-b' });
        expect(a).not.toBe(b);
    });

    it('different keys (same scope) produce different tags', () => {
        const a = generateMasterKey();
        const b = generateMasterKey();
        const scope = { kind: 'codebase' as const, key: 'repo-a' };
        expect(deriveScopeRoutingTag(a, scope)).not.toBe(deriveScopeRoutingTag(b, scope));
    });

    it('different scope kinds produce different tags', () => {
        const k = generateMasterKey();
        const a = deriveScopeRoutingTag(k, { kind: 'codebase', key: 'x' });
        const b = deriveScopeRoutingTag(k, { kind: 'framework', key: 'x' });
        expect(a).not.toBe(b);
    });
});

/** ─── fingerprintMasterKey ─── */

describe('fingerprintMasterKey', () => {
    it('returns 16 hex chars', () => {
        expect(fingerprintMasterKey(generateMasterKey())).toMatch(/^[a-f0-9]{16}$/);
    });

    it('is deterministic + key-isolated + different from user hash (different domain separator)', () => {
        const k = generateMasterKey();
        expect(fingerprintMasterKey(k)).toBe(fingerprintMasterKey(k));
        expect(fingerprintMasterKey(k)).not.toBe(deriveUserHash(k));
    });
});

/** ─── encrypt/decrypt round-trip ─── */

describe('encryptEnvelope / decryptEnvelope', () => {
    it('round-trips a plaintext through encrypt + decrypt', () => {
        const k = generateMasterKey();
        const plaintext = JSON.stringify({ op: 'feedback', concept_slug: 'attention', delta: 1 });
        const env = encryptEnvelope(plaintext, k);
        expect(env.v).toBe(1);
        expect(env.e).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(decryptEnvelope(env, k)).toBe(plaintext);
    });

    it('produces a different ciphertext each call (random nonce + ephemeral keypair)', () => {
        const k = generateMasterKey();
        const plaintext = 'identical input';
        const a = encryptEnvelope(plaintext, k);
        const b = encryptEnvelope(plaintext, k);
        expect(a.c).not.toBe(b.c);
        expect(a.n).not.toBe(b.n);
        expect(a.e).not.toBe(b.e);
    });

    it('decrypts to the same plaintext from any envelope produced with the same key', () => {
        const k = generateMasterKey();
        const plaintext = 'shared secret content';
        const a = encryptEnvelope(plaintext, k);
        const b = encryptEnvelope(plaintext, k);
        expect(decryptEnvelope(a, k)).toBe(plaintext);
        expect(decryptEnvelope(b, k)).toBe(plaintext);
    });

    it('decrypting with a different key throws (AEAD failure)', () => {
        const k1 = generateMasterKey();
        const k2 = generateMasterKey();
        const env = encryptEnvelope('secret', k1);
        expect(() => decryptEnvelope(env, k2)).toThrow();
    });

    it('detects tampering in the ciphertext', () => {
        const k = generateMasterKey();
        const env = encryptEnvelope('attack at dawn', k);
        const tampered: EncryptionEnvelope = {
            ...env,
            c: Buffer.from(env.c, 'base64')
                .map((b, i) => (i === 0 ? b ^ 0x01 : b))
                .toString('base64'),
        };
        expect(() => decryptEnvelope(tampered, k)).toThrow();
    });

    it('detects tampering in the nonce', () => {
        const k = generateMasterKey();
        const env = encryptEnvelope('attack at dawn', k);
        const tampered: EncryptionEnvelope = {
            ...env,
            n: Buffer.from(env.n, 'base64')
                .map((b, i) => (i === 0 ? b ^ 0x01 : b))
                .toString('base64'),
        };
        expect(() => decryptEnvelope(tampered, k)).toThrow();
    });

    it('detects tampering in the ephemeral public key', () => {
        const k = generateMasterKey();
        const env = encryptEnvelope('attack at dawn', k);
        const tampered: EncryptionEnvelope = {
            ...env,
            e: Buffer.from(env.e, 'base64')
                .map((b, i) => (i === 0 ? b ^ 0x01 : b))
                .toString('base64'),
        };
        expect(() => decryptEnvelope(tampered, k)).toThrow();
    });

    it('rejects envelopes with the wrong version', () => {
        const k = generateMasterKey();
        const env = encryptEnvelope('hello', k);
        const wrongVersion = { ...env, v: 2 as 1 };
        expect(() => decryptEnvelope(wrongVersion, k)).toThrow(/unsupported envelope version/);
    });

    it('rejects envelopes with malformed sizes', () => {
        const k = generateMasterKey();
        const malformed: EncryptionEnvelope = {
            v: 1,
            e: Buffer.alloc(8).toString('base64'),
            n: Buffer.alloc(24).toString('base64'),
            c: Buffer.alloc(16).toString('base64'),
        };
        expect(() => decryptEnvelope(malformed, k)).toThrow(/envelope.e wrong size/);
    });

    it('survives JSON round-trip (envelopes ship as JSON over HTTP)', () => {
        const k = generateMasterKey();
        const env = encryptEnvelope('payload', k);
        const fromJson = JSON.parse(JSON.stringify(env)) as EncryptionEnvelope;
        expect(decryptEnvelope(fromJson, k)).toBe('payload');
    });
});

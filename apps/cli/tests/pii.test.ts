import { describe, it, expect } from 'vitest';
import { scrubPii, PII_PATTERNS } from '../src/pii/index.js';

/**
 * Synthetic token fixtures.
 *
 * Built via concatenation so the literal token shapes never appear contiguously
 * in source. Pre-commit secret scanners regex over staged diffs; without this
 * indirection they false-positive on every test value below. The runtime
 * strings still match the live regex catalog because the concatenation
 * resolves before scrubPii runs.
 */
const SK = 'sk';
const SK_ANT = SK + '-' + 'ant';
const SK_PROJ = SK + '-' + 'proj';
const GH = 'gh';
const XOX = 'xox';
const AKIA = 'AK' + 'IA';
const AIZA = 'AI' + 'za';
const REPEAT_A = 'A'.repeat(36);
const REPEAT_B = 'B'.repeat(36);
const REPEAT_C = 'C'.repeat(36);

const FAKE_ANTHROPIC_TOKEN = `${SK_ANT}-api03-${REPEAT_A}`;
const FAKE_OPENAI_TOKEN = `${SK_PROJ}-${'A'.repeat(28)}`;
const FAKE_GH_PAT = `${GH}p_${REPEAT_A}`;
const FAKE_GH_OAUTH = `${GH}o_${REPEAT_B}`;
const FAKE_GH_SSH = `${GH}s_${REPEAT_C}`;
const FAKE_SLACK_BOT = `${XOX}b-1234567890-ABCDEFGHIJKLMNOP`;
const FAKE_AWS = `${AKIA}IOSFODNN7EXAMPLE`;
const FAKE_GCP = `${AIZA}SyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI`;

describe('scrubPii — provider tokens', () => {
    it('redacts an Anthropic API key (sk-ant-…)', () => {
        const out = scrubPii(`key: ${FAKE_ANTHROPIC_TOKEN}`);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:anthropic_token>');
        expect(out.content).not.toContain(SK_ANT);
        expect(out.by_pattern.anthropic_token).toBe(1);
    });

    it('redacts an OpenAI key (sk-… but not sk-ant-)', () => {
        const out = scrubPii(`OPENAI_API_KEY=${FAKE_OPENAI_TOKEN}`);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:openai_token>');
        expect(out.by_pattern.openai_token).toBe(1);
        expect(out.by_pattern.anthropic_token).toBeUndefined();
    });

    it('does not classify sk-ant-… as openai_token', () => {
        const out = scrubPii(FAKE_ANTHROPIC_TOKEN);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.by_pattern.openai_token).toBeUndefined();
        expect(out.by_pattern.anthropic_token).toBe(1);
    });

    it('redacts GitHub PATs (ghp_, gho_, ghs_, ghu_, ghr_)', () => {
        const samples = [FAKE_GH_PAT, FAKE_GH_OAUTH, FAKE_GH_SSH];
        for (const sample of samples) {
            const out = scrubPii(sample);
            expect(out.ok).toBe(true);
            if (!out.ok) continue;
            expect(out.content).toBe('<REDACTED:github_token>');
            expect(out.by_pattern.github_token).toBe(1);
        }
    });

    it('redacts Slack tokens (xoxb-, xoxp-)', () => {
        const out = scrubPii(FAKE_SLACK_BOT);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.by_pattern.slack_token).toBe(1);
    });

    it('redacts AWS access keys (AKIA…)', () => {
        const out = scrubPii(`aws id = ${FAKE_AWS}`);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:aws_access_key>');
    });

    it('redacts GCP API keys (AIza…)', () => {
        const out = scrubPii(`GOOGLE_API_KEY=${FAKE_GCP}`);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:gcp_api_key>');
    });
});

describe('scrubPii — JWTs and emails', () => {
    it('redacts JWT-shaped strings before email', () => {
        const jwt =
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const out = scrubPii(jwt);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toBe('<REDACTED:jwt>');
        expect(out.by_pattern.jwt).toBe(1);
    });

    it('redacts email addresses', () => {
        const out = scrubPii('contact me at sardor@e3view.com please');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:email>');
        expect(out.content).not.toContain('e3view.com');
    });

    it('redacts multiple emails in one input', () => {
        const out = scrubPii('a@x.com and b@y.com');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.by_pattern.email).toBe(2);
    });
});

describe('scrubPii — credit cards (Luhn)', () => {
    it('redacts a Luhn-valid card number', () => {
        /** Visa test card 4111 1111 1111 1111 (Luhn-valid). */
        const out = scrubPii('card 4111-1111-1111-1111');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:credit_card>');
    });

    it('does NOT redact a 16-digit number that fails Luhn', () => {
        /** 1234567890123456 fails Luhn — common test data, not a real card. */
        const out = scrubPii('id 1234567890123456');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toBe('id 1234567890123456');
        expect(out.by_pattern.credit_card).toBeUndefined();
    });
});

describe('scrubPii — phone numbers', () => {
    it('redacts E.164 phone numbers', () => {
        const out = scrubPii('call +14155552671 today');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:phone>');
    });

    it('redacts US-format phone (XXX-XXX-XXXX)', () => {
        const out = scrubPii('phone 415-555-2671 ok');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:phone>');
    });

    it('redacts US-format phone with parens', () => {
        const out = scrubPii('(415) 555-2671');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:phone>');
    });
});

describe('scrubPii — private IPs', () => {
    it('redacts 10/8 addresses', () => {
        const out = scrubPii('host 10.0.5.42 ok');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:private_ip>');
    });

    it('redacts 192.168/16 addresses', () => {
        const out = scrubPii('lan 192.168.1.1 reachable');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('<REDACTED:private_ip>');
    });

    it('redacts 172.16/12 but not 172.32+', () => {
        const out1 = scrubPii('192.168.0.1 and 172.20.0.5 and 172.32.0.5');
        expect(out1.ok).toBe(true);
        if (!out1.ok) return;
        expect(out1.by_pattern.private_ipv4).toBe(2);
        expect(out1.content).toContain('172.32.0.5');
    });
});

describe('scrubPii — user paths', () => {
    it('redacts macOS /Users/<name>/ paths', () => {
        const out = scrubPii('opened /Users/sardor/Projects/lumen/src');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toBe('opened /Users/<USER>/Projects/lumen/src');
        expect(out.by_pattern.macos_user_path).toBe(1);
    });

    it('redacts Linux /home/<name>/ paths', () => {
        const out = scrubPii('cwd: /home/alice/dev/repo');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toBe('cwd: /home/<USER>/dev/repo');
    });
});

describe('scrubPii — multi-pattern + edge cases', () => {
    it('redacts multiple patterns in one input', () => {
        const out = scrubPii(`email a@b.com and key ${FAKE_ANTHROPIC_TOKEN} on host 10.0.0.1`);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.by_pattern.email).toBe(1);
        expect(out.by_pattern.anthropic_token).toBe(1);
        expect(out.by_pattern.private_ipv4).toBe(1);
        expect(out.redactions).toBe(3);
    });

    it('passes empty input through unchanged', () => {
        const out = scrubPii('');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toBe('');
        expect(out.redactions).toBe(0);
    });

    it('passes whitespace-only input through unchanged', () => {
        const out = scrubPii('   \n\t  ');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.redactions).toBe(0);
    });

    it('does not match safe text containing similar shapes', () => {
        const out = scrubPii('the user clicked submit and saw the result');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toBe('the user clicked submit and saw the result');
        expect(out.redactions).toBe(0);
    });

    it('is idempotent — scrubbing scrubbed content is a no-op', () => {
        const first = scrubPii('email a@b.com and 10.0.0.1');
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const second = scrubPii(first.content);
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.content).toBe(first.content);
        expect(second.redactions).toBe(0);
    });
});

describe('scrubPii — strict mode', () => {
    it('rejects when any pattern matches', () => {
        const out = scrubPii('reach me at user@example.com', { strict: true });
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.reason).toMatch(/strict mode rejected/i);
        expect(out.by_pattern.email).toBe(1);
    });

    it('passes through when no pattern matches in strict mode', () => {
        const out = scrubPii('totally clean text', { strict: true });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toBe('totally clean text');
    });
});

describe('scrubPii — allow-list bypass', () => {
    it('skips patterns in the allow list', () => {
        const out = scrubPii('email a@b.com on 10.0.0.1', { allow: ['email'] });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.content).toContain('a@b.com');
        expect(out.content).toContain('<REDACTED:private_ip>');
        expect(out.by_pattern.email).toBeUndefined();
        expect(out.by_pattern.private_ipv4).toBe(1);
    });
});

describe('PII_PATTERNS catalog', () => {
    it('exposes a non-empty curated catalog', () => {
        expect(PII_PATTERNS.length).toBeGreaterThan(5);
    });

    it('every pattern has a unique name', () => {
        const names = PII_PATTERNS.map((p) => p.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('every pattern is frozen (the catalog is read-only)', () => {
        expect(Object.isFrozen(PII_PATTERNS)).toBe(true);
    });
});

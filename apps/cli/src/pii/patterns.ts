/**
 * Curated PII pattern catalog.
 *
 * Two-stage gate (regex first, optional LLM second pass) per
 * `docs/docs-temp/AGENT-LEARNING-SUBSTRATE.md` §6.4. This file is the regex
 * stage - deterministic, documentable, ~80% coverage. The LLM second pass
 * lands later when the broker tier (§10) is built.
 *
 * Pattern design:
 *   - Each pattern has a stable `name` (used by allow-lists and diagnostics).
 *   - `replacement` is a fixed token that survives across runs (so two devices
 *     scrubbing the same input produce identical output - load-bearing for
 *     dedup once cross-device sync ships).
 *   - `validate` is an optional second-stage check for shapes that match many
 *     false positives (credit-card-shape passes Luhn; user paths require a
 *     valid leading prefix).
 *
 * Order matters: more specific patterns run first so a JWT in an Authorization
 * header isn't mis-classified as a generic email by the @ inside it.
 */

export type PiiPatternName =
    | 'anthropic_token'
    | 'openai_token'
    | 'github_token'
    | 'slack_token'
    | 'aws_access_key'
    | 'gcp_api_key'
    | 'jwt'
    | 'email'
    | 'credit_card'
    | 'phone_e164'
    | 'phone_us'
    | 'private_ipv4'
    | 'macos_user_path'
    | 'linux_user_path';

export type PiiPattern = {
    name: PiiPatternName;
    description: string;
    pattern: RegExp;
    replacement: string;
    /** Optional secondary check; return false to keep the original substring. */
    validate?: (match: string) => boolean;
};

/**
 * Patterns are evaluated in order. Later patterns operate on the output of
 * earlier ones (already-redacted substrings are inert).
 */
export const PII_PATTERNS: readonly PiiPattern[] = Object.freeze([
    /** Provider tokens - long, distinctive prefixes; almost zero false-positive risk. */
    {
        name: 'anthropic_token',
        description: 'Anthropic API key (sk-ant-...)',
        pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
        replacement: '<REDACTED:anthropic_token>',
    },
    {
        name: 'openai_token',
        description: 'OpenAI API key (sk-... but not sk-ant-)',
        pattern: /\bsk-(?!ant-)[a-zA-Z0-9_-]{20,}\b/g,
        replacement: '<REDACTED:openai_token>',
    },
    {
        name: 'github_token',
        description: 'GitHub PAT (ghp_, gho_, ghu_, ghs_, ghr_)',
        pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
        replacement: '<REDACTED:github_token>',
    },
    {
        name: 'slack_token',
        description: 'Slack bot/user token (xoxb-, xoxp-, xoxa-, xoxr-)',
        pattern: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/g,
        replacement: '<REDACTED:slack_token>',
    },
    {
        name: 'aws_access_key',
        description: 'AWS access key ID (AKIA...)',
        pattern: /\bAKIA[0-9A-Z]{16}\b/g,
        replacement: '<REDACTED:aws_access_key>',
    },
    {
        name: 'gcp_api_key',
        description: 'Google Cloud API key (AIza...)',
        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
        replacement: '<REDACTED:gcp_api_key>',
    },

    /** JWTs come before email so the embedded `.` segments aren't broken up. */
    {
        name: 'jwt',
        description: 'JWT-shaped string (3 base64url segments)',
        pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        replacement: '<REDACTED:jwt>',
    },

    /** Email - generic enough to catch user identifiers. */
    {
        name: 'email',
        description: 'Email address',
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        replacement: '<REDACTED:email>',
    },

    /** Credit card shape with Luhn validation to drop random 16-digit IDs. */
    {
        name: 'credit_card',
        description: '13-19 digit number passing Luhn check',
        pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
        replacement: '<REDACTED:credit_card>',
        validate: (raw: string) => luhnValid(raw.replace(/[^0-9]/g, '')),
    },

    /**
     * Phone numbers - E.164 first (more specific), then US format.
     * The leading anchor avoids snagging the middle of a longer digit run.
     */
    {
        name: 'phone_e164',
        description: 'E.164 phone number (+CCXXXXXXXXXX)',
        pattern: /\+[1-9]\d{7,14}\b/g,
        replacement: '<REDACTED:phone>',
    },
    {
        /**
         * Two branches with different leading anchors: `\b` works for the dash
         * form because both sides of `\b` are word chars; for the paren form
         * `\b(` fails at string start because `(` is non-word, so use a
         * negative lookbehind that rejects only digits and hyphens (which
         * would suggest the parens are inside a longer number).
         */
        name: 'phone_us',
        description: 'US-format phone (XXX-XXX-XXXX, (XXX) XXX-XXXX)',
        pattern: /(?:\b\d{3}[-.\s]|(?<![\d-])\(\d{3}\)\s?)\d{3}[-.\s]\d{4}\b/g,
        replacement: '<REDACTED:phone>',
    },

    /** Private IPv4 ranges (RFC 1918). Useful for not leaking internal hosts. */
    {
        name: 'private_ipv4',
        description: 'Private IPv4 (10/8, 172.16/12, 192.168/16)',
        pattern:
            /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
        replacement: '<REDACTED:private_ip>',
    },

    /**
     * Home-directory paths embed the local username. Replace the username
     * component, preserve the rest of the path so the trajectory still
     * communicates *what* file was touched.
     */
    {
        name: 'macos_user_path',
        description: 'macOS home path (/Users/<name>/...)',
        pattern: /\/Users\/[^/\s'"]+/g,
        replacement: '/Users/<USER>',
    },
    {
        name: 'linux_user_path',
        description: 'Linux home path (/home/<name>/...)',
        pattern: /\/home\/[^/\s'"]+/g,
        replacement: '/home/<USER>',
    },
]);

/** Standard Luhn checksum for credit-card validation. */
function luhnValid(digits: string): boolean {
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let n = digits.charCodeAt(i) - 48;
        if (n < 0 || n > 9) return false;
        if (alt) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
        alt = !alt;
    }
    return sum % 10 === 0;
}

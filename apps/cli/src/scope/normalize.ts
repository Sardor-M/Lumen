/**
 * Git remote URL normalization.
 *
 * Two devices that have cloned the same repo via different URLs (HTTPS vs SSH;
 * org URL vs personal fork) must collapse to the same canonical form so that
 * the codebase scope key is stable across machines.
 *
 * See `docs/docs-temp/SCOPE-RESOLUTION.md` §2.1 for the spec.
 */

const SSH_LIKE = /^([\w.-]+@)?([\w.-]+):([\w./~-]+)$/;

/**
 * Normalize a git remote URL to a canonical lowercase form:
 *   - Strip trailing whitespace, trailing `.git`, trailing slash
 *   - Convert `git@host:user/repo` → `https://host/user/repo`
 *   - Strip user/password components (`https://user:pass@host/...`)
 *   - Strip query string and fragment
 *   - Lowercase host + path
 *
 * Returns null for empty / whitespace-only / non-URL input.
 */
export function normalizeGitRemote(input: string): string | null {
    const raw = input?.trim();
    if (!raw) return null;

    /** SSH form: git@host:owner/repo(.git)? — convert to HTTPS. */
    const sshMatch = SSH_LIKE.exec(raw);
    if (sshMatch && !raw.includes('://')) {
        const host = sshMatch[2];
        const path = sshMatch[3];
        return canonicalize(`https://${host}/${path}`);
    }

    return canonicalize(raw);
}

function canonicalize(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    /** Strip credentials. */
    url.username = '';
    url.password = '';
    /** Strip query + fragment. */
    url.search = '';
    url.hash = '';

    /** Coerce ssh://, git+ssh://, etc. to https://. */
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        url.protocol = 'https:';
    }

    /** Drop the port if it's the default for the protocol. */
    if (url.port === '443' || url.port === '80') {
        url.port = '';
    }

    let pathname = url.pathname.replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!pathname.startsWith('/')) pathname = '/' + pathname;

    const host = url.host.toLowerCase();
    const path = pathname.toLowerCase();

    return `${url.protocol}//${host}${path}`;
}

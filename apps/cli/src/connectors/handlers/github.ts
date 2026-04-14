import type { ConnectorHandler, PullResult } from '../types.js';
import type { Connector, ExtractionResult } from '../../types/index.js';

type GithubConfig = {
    owner: string;
    repo: string;
    include_readme: boolean;
    max_results: number;
};

type GithubState = {
    /** ISO timestamp passed to GitHub's `since` param — filters by updated_at. */
    since: string | null;
    last_readme_sha: string | null;
};

const DEFAULT_MAX_RESULTS = 50;
const REPO_PATTERN = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/;

export const githubHandler: ConnectorHandler = {
    type: 'github',

    parseTarget(target, options) {
        const match = target.trim().match(REPO_PATTERN);
        if (!match) {
            throw new Error(`GitHub target must be "owner/repo", got: "${target}"`);
        }
        const [, owner, repo] = match;

        const maxResults = parseMaxResults(options.max_results);
        const includeReadme = options.include_readme !== false;

        const config: GithubConfig = {
            owner,
            repo,
            include_readme: includeReadme,
            max_results: maxResults,
        };
        const initialState: GithubState = { since: null, last_readme_sha: null };

        return {
            id: `github:${owner}-${repo}`.toLowerCase(),
            name: `${owner}/${repo}`,
            config,
            initialState,
        };
    },

    async pull(connector: Connector): Promise<PullResult> {
        const config = parseConfig(connector.config);
        const state = parseState(connector.state);
        const token = process.env.GITHUB_TOKEN ?? null;

        const items: ExtractionResult[] = [];
        const now = new Date().toISOString();

        /** 1. Issues + PRs (GitHub's issues API returns both). */
        const issues = await fetchIssues(config, state.since, token);
        for (const issue of issues) {
            items.push(issueToExtraction(issue, config.owner, config.repo));
        }

        /** 2. README — only re-emit when the SHA changes. */
        let newReadmeSha = state.last_readme_sha;
        if (config.include_readme) {
            const readme = await fetchReadme(config, token).catch(() => null);
            if (readme && readme.sha !== state.last_readme_sha) {
                items.push(readmeToExtraction(readme, config.owner, config.repo));
                newReadmeSha = readme.sha;
            }
        }

        const newState: GithubState = { since: now, last_readme_sha: newReadmeSha };
        return { new_items: items, new_state: newState };
    },
};

function parseMaxResults(raw: unknown): number {
    if (raw === undefined) return DEFAULT_MAX_RESULTS;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw new Error('GitHub --max-results must be an integer between 1 and 100');
    }
    return n;
}

function parseConfig(raw: string): GithubConfig {
    const parsed = JSON.parse(raw) as Partial<GithubConfig>;
    if (typeof parsed.owner !== 'string' || typeof parsed.repo !== 'string') {
        throw new Error('GitHub connector config missing "owner" or "repo"');
    }
    return {
        owner: parsed.owner,
        repo: parsed.repo,
        include_readme: parsed.include_readme !== false,
        max_results:
            typeof parsed.max_results === 'number' && parsed.max_results > 0
                ? parsed.max_results
                : DEFAULT_MAX_RESULTS,
    };
}

function parseState(raw: string): GithubState {
    try {
        const parsed = JSON.parse(raw) as Partial<GithubState>;
        return {
            since: typeof parsed.since === 'string' ? parsed.since : null,
            last_readme_sha:
                typeof parsed.last_readme_sha === 'string' ? parsed.last_readme_sha : null,
        };
    } catch {
        return { since: null, last_readme_sha: null };
    }
}

function headers(token: string | null): HeadersInit {
    const h: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'lumen-connector/1.0',
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
}

type GithubIssue = {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    user: { login: string } | null;
    labels: Array<{ name: string }>;
    created_at: string;
    updated_at: string;
    pull_request?: unknown;
};

async function fetchIssues(
    config: GithubConfig,
    since: string | null,
    token: string | null,
): Promise<GithubIssue[]> {
    const params = new URLSearchParams({
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: String(config.max_results),
    });
    if (since) params.set('since', since);

    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/issues?${params.toString()}`;
    const res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(15000) });

    if (res.status === 401 || res.status === 403) {
        const rate = res.headers.get('x-ratelimit-remaining');
        throw new Error(
            `GitHub API returned ${res.status}${rate === '0' ? ' (rate-limited — set GITHUB_TOKEN env var for 5000 req/hour)' : ''}`,
        );
    }
    if (!res.ok) {
        throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as GithubIssue[];
}

type GithubReadme = {
    content: string;
    encoding: string;
    sha: string;
    html_url: string;
    path: string;
};

async function fetchReadme(
    config: GithubConfig,
    token: string | null,
): Promise<GithubReadme | null> {
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/readme`;
    const res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub README fetch returned ${res.status}`);
    return (await res.json()) as GithubReadme;
}

function issueToExtraction(issue: GithubIssue, owner: string, repo: string): ExtractionResult {
    const isPr = issue.pull_request !== undefined;
    const kind = isPr ? 'PR' : 'Issue';
    const labels = issue.labels.map((l) => l.name).join(', ');
    const body = issue.body?.trim() ?? '';

    const header = `# ${kind} #${issue.number}: ${issue.title}`;
    const meta = `Repository: ${owner}/${repo}\nState: ${issue.state}\nAuthor: ${issue.user?.login ?? 'unknown'}${labels ? `\nLabels: ${labels}` : ''}\nCreated: ${issue.created_at}\nUpdated: ${issue.updated_at}`;
    const content = [header, '', meta, '', body].join('\n');

    return {
        title: `${owner}/${repo} ${kind} #${issue.number}: ${issue.title}`,
        content,
        url: issue.html_url,
        source_type: 'url',
        language: null,
        metadata: {
            github_kind: isPr ? 'pull_request' : 'issue',
            github_number: issue.number,
            github_state: issue.state,
            github_author: issue.user?.login ?? null,
            github_labels: issue.labels.map((l) => l.name),
            updated_at: issue.updated_at,
        },
    };
}

function readmeToExtraction(readme: GithubReadme, owner: string, repo: string): ExtractionResult {
    const content =
        readme.encoding === 'base64'
            ? Buffer.from(readme.content, 'base64').toString('utf-8')
            : readme.content;

    return {
        title: `${owner}/${repo} README`,
        content,
        url: readme.html_url,
        source_type: 'url',
        language: null,
        metadata: {
            github_kind: 'readme',
            github_path: readme.path,
            github_sha: readme.sha,
        },
    };
}

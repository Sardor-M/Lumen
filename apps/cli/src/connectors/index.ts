import { registerHandler } from './registry.js';
import { rssHandler } from './handlers/rss.js';
import { folderHandler } from './handlers/folder.js';
import { arxivHandler } from './handlers/arxiv.js';
import { githubHandler } from './handlers/github.js';
import { youtubeChannelHandler } from './handlers/youtube-channel.js';
import { obsidianHandler } from './handlers/obsidian.js';

/**
 * Registers every built-in handler once at import time. CLI commands and
 * the daemon both `import './connectors/index.js'` before using the runner.
 */
let initialized = false;

export function initConnectors(): void {
    if (initialized) return;
    registerHandler(rssHandler);
    registerHandler(folderHandler);
    registerHandler(arxivHandler);
    registerHandler(githubHandler);
    registerHandler(youtubeChannelHandler);
    registerHandler(obsidianHandler);
    initialized = true;
}

export { runConnector, runDue, runAll, runOne } from './runner.js';
export type { PullSummary } from './runner.js';
export { getHandler, listHandlerTypes } from './registry.js';

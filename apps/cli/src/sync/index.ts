/**
 * Public sync module surface.
 *
 * Tier 5a — local journal foundation. Tier 5b adds encryption (sibling
 * crypto.ts). Tier 5c adds the HTTP relay client; Tier 5e adds apply rules.
 */

export {
    appendJournal,
    listUnpushed,
    listUnapplied,
    markPushed,
    markApplied,
    countJournal,
    countUnpushed,
} from './journal.js';

export {
    getOrInitSyncState,
    setEnabled,
    setRelayConfig,
    updateCursor,
    setLastError,
} from './state.js';

export type {
    JournalOp,
    JournalEntry,
    SyncState,
    TrajectoryPayload,
    FeedbackPayload,
    TruthUpdatePayload,
    RetirePayload,
    ConceptCreatePayload,
} from './types.js';

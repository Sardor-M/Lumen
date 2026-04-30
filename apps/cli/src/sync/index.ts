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
    insertPulled,
    markPushed,
    markApplied,
    countJournal,
    countUnpushed,
} from './journal.js';

export {
    setMasterKey,
    getMasterKey,
    deleteMasterKey,
    hasMasterKey,
    setKeyringBackend,
    getKeyringBackend,
} from './keyring.js';
export type { KeyringBackend } from './keyring.js';

export {
    postJournal,
    getJournal,
    deleteJournal,
    relayError,
    isRelayError,
} from './relay-client.js';
export type {
    RelayError,
    PushBatch,
    PushEntry,
    PushResult,
    PullBatch,
    PullEntry,
    GetJournalOptions,
    FetchLike,
} from './relay-client.js';

export {
    runPush,
    runPull,
    runSync,
    clearLastError,
    computeLocalScopeTags,
    resetCircuitBreakerForTests,
} from './sync-driver.js';
export type { SyncResult, DriverOptions } from './sync-driver.js';

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

export {
    generateMasterKey,
    deriveUserHash,
    deriveScopeRoutingTag,
    fingerprintMasterKey,
    encryptEnvelope,
    decryptEnvelope,
    MASTER_KEY_BYTES,
    XCHACHA_NONCE_BYTES,
    USER_HASH_HEX_LENGTH,
    SCOPE_TAG_HEX_LENGTH,
} from './crypto.js';

export type { EncryptionEnvelope } from './crypto.js';

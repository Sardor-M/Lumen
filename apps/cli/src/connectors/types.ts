import type { Connector, ConnectorType, ExtractionResult } from '../types/index.js';

/** Result of one pull: new extracted items + the updated cursor. */
export type PullResult = {
    new_items: ExtractionResult[];
    new_state: Record<string, unknown>;
};

/** Each connector type registers one handler. `pull()` is pure with respect to
 *  the store — the runner persists the result. */
export type ConnectorHandler = {
    type: ConnectorType;
    /** Parse a user-provided target into an initial config+state, or throw
     *  with a clear error message describing the expected format. */
    parseTarget(
        target: string,
        options: Record<string, unknown>,
    ): {
        id: string;
        name: string;
        config: Record<string, unknown>;
        initialState: Record<string, unknown>;
    };
    /** Fetch new items since the cursor in `connector.state`. */
    pull(connector: Connector): Promise<PullResult>;
};

export type ConnectorConfig = Record<string, unknown>;
export type ConnectorState = Record<string, unknown>;

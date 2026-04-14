import type { ConnectorHandler } from './types.js';
import type { ConnectorType } from '../types/index.js';

const handlers = new Map<ConnectorType, ConnectorHandler>();

/** Register a handler for a connector type. Called once per handler module. */
export function registerHandler(handler: ConnectorHandler): void {
    handlers.set(handler.type, handler);
}

export function getHandler(type: ConnectorType): ConnectorHandler | null {
    return handlers.get(type) ?? null;
}

export function listHandlerTypes(): ConnectorType[] {
    return [...handlers.keys()];
}

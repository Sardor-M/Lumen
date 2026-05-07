/**
 * Tests for the `lumen install claude` Stop hook (Layer 1 of sync
 * automation, issue #24). The hook is regenerated on every install,
 * so the contract is the *content* of `signalHookScript()` — assert
 * that auto-push happens before the existing capture-nudge logic and
 * that the auto-push line carries the time-bound + silent-fail wrapper.
 */

import { describe, it, expect } from 'vitest';
import { signalHookScript } from '../src/commands/install.js';

describe('signalHookScript — Tier 5/6 bridge (Layer 1 auto-push)', () => {
    const hook = signalHookScript();

    it('starts with the bash shebang + strict mode', () => {
        expect(hook.startsWith('#!/usr/bin/env bash\nset -euo pipefail\n')).toBe(true);
    });

    it('includes the auto-push command before the capture-nudge logic', () => {
        const pushIdx = hook.indexOf('lumen sync run');
        const captureIdx = hook.indexOf('Lumen brain has');
        expect(pushIdx).toBeGreaterThan(0);
        expect(captureIdx).toBeGreaterThan(pushIdx);
    });

    it('time-bounds the auto-push so a slow relay does not stall the agent', () => {
        expect(hook).toMatch(/timeout\s+8\s+lumen sync run/);
    });

    it('silences stdout/stderr and swallows non-zero exits', () => {
        /**
         * The full pattern: `timeout 8 lumen sync run >/dev/null 2>&1 || true`.
         * The `|| true` is what makes a sync failure (disabled, no relay,
         * unreachable, circuit-broken) a no-op for the agent loop instead
         * of bubbling up a non-zero exit that breaks Claude Code.
         */
        expect(hook).toContain('lumen sync run >/dev/null 2>&1 || true');
    });

    it('preserves the existing capture-nudge logic for the Stop event', () => {
        expect(hook).toContain('TOOL_NAME="${1:-}"');
        expect(hook).toContain('if [[ "$TOOL_NAME" == "Stop" ]]');
        expect(hook).toContain('lumen status --json');
        expect(hook).toContain('call the capture MCP tool now');
        expect(hook).toContain('call capture to start growing the brain');
    });

    it('emits a single capture-nudge branch per code path (no duplicate echos)', () => {
        const echoCount = (hook.match(/^\s*echo /gm) ?? []).length;
        expect(echoCount).toBe(2); // one for has-concepts, one for empty brain
    });
});

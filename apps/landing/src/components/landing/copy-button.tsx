'use client';

import { useClipboard } from '@lumen/ui';

export function CopyButton({ cmd }: { cmd: string }) {
    const { copied, copy } = useClipboard();

    return (
        <button type="button" onClick={() => copy(cmd)} className={copied ? 'ok' : undefined}>
            <span className="ico">{copied ? '✓' : '⎘'}</span>
            <span className="lbl">{copied ? 'copied' : 'copy'}</span>
        </button>
    );
}

export function InstallBox({ cmd, maxWidth }: { cmd: string; maxWidth?: number }) {
    return (
        <div className="install" style={maxWidth ? { maxWidth } : undefined}>
            <span className="prompt">$</span>
            <code>{cmd}</code>
            <CopyButton cmd={cmd} />
        </div>
    );
}

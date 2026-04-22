'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type UseClipboardOptions = {
    /** Milliseconds before `copied` resets to false. */
    resetMs?: number;
};

export type UseClipboardResult = {
    copied: boolean;
    copy: (text: string) => void;
};

export function useClipboard({ resetMs = 1400 }: UseClipboardOptions = {}): UseClipboardResult {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const copy = useCallback(
        (text: string) => {
            navigator.clipboard
                ?.writeText(text)
                .then(() => {
                    setCopied(true);
                    if (timer.current) clearTimeout(timer.current);
                    timer.current = setTimeout(() => setCopied(false), resetMs);
                })
                .catch(() => {
                    setCopied(false);
                });
        },
        [resetMs],
    );

    useEffect(() => {
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, []);

    return { copied, copy };
}

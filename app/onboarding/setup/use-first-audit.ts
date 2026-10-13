'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditStreamEvent } from '@/lib/audit/progress';
import {
  classifyAuditStartError,
  firstAuditGuardKey,
  isFirstAuditGuardActive,
} from '@/lib/onboarding/first-opportunities';

export type FirstAuditStatus =
  | { kind: 'idle' }
  | { kind: 'running'; percent: number; message: string }
  /** Started before a refresh or by another tab: the server finishes it, we wait for the row. */
  | { kind: 'waiting' }
  | { kind: 'done' }
  | { kind: 'exhausted' }
  | { kind: 'error'; message: string };

function readGuard(key: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writeGuard(key: string, value: number | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, String(value));
  } catch {
    // Private mode: the ref guard still stops a double start in this tab.
  }
}

/**
 * The first audit, run in the background while «مُضاعِف» asks his questions.
 * Same endpoint, progress stream and refresh guard as the old first-audit
 * screen, so a refresh never starts (and bills) a second audit.
 */
export function useFirstAudit(customerId: string | null) {
  const [status, setStatus] = useState<FirstAuditStatus>({ kind: 'idle' });
  const started = useRef(false);

  const start = useCallback(async () => {
    if (!customerId) return;
    const guardKey = firstAuditGuardKey(customerId);
    if (started.current) return;
    started.current = true;
    if (isFirstAuditGuardActive(readGuard(guardKey))) {
      setStatus({ kind: 'waiting' });
      return;
    }
    writeGuard(guardKey, Date.now());
    setStatus({ kind: 'running', percent: 2, message: 'أجهز الفحص' });
    try {
      const res = await fetch('/api/audit/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ customerId }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const outcome = classifyAuditStartError(res.status, body.error);
        if (outcome === 'running') {
          writeGuard(guardKey, Date.now());
          setStatus({ kind: 'waiting' });
          return;
        }
        writeGuard(guardKey, null);
        if (outcome === 'exhausted') {
          setStatus({ kind: 'exhausted' });
          return;
        }
        started.current = false;
        setStatus({ kind: 'error', message: body.message ?? 'ما قدرت أبدأ الفحص الحين.' });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: AuditStreamEvent;
          try {
            event = JSON.parse(line) as AuditStreamEvent;
          } catch {
            continue;
          }
          if (event.type === 'progress') {
            setStatus({ kind: 'running', percent: event.percent, message: event.message });
          } else if (event.type === 'complete') {
            writeGuard(guardKey, null);
            setStatus({ kind: 'done' });
            return;
          } else if (event.type === 'error') {
            writeGuard(guardKey, null);
            started.current = false;
            setStatus({ kind: 'error', message: event.message });
            return;
          }
        }
      }
      // Closed without a final event: the audit may still have saved. Wait for the row.
      writeGuard(guardKey, Date.now());
      setStatus({ kind: 'waiting' });
    } catch {
      setStatus({ kind: 'waiting' });
    }
  }, [customerId]);

  const retry = useCallback(() => {
    started.current = false;
    if (customerId) writeGuard(firstAuditGuardKey(customerId), null);
    void start();
  }, [customerId, start]);

  /** A row seen by the page (state reload) settles a waiting audit. */
  const markDone = useCallback(() => setStatus({ kind: 'done' }), []);

  // A waiting audit times out with the guard, then offers a retry.
  useEffect(() => {
    if (status.kind !== 'waiting' || !customerId) return;
    const key = firstAuditGuardKey(customerId);
    const timer = setInterval(() => {
      if (!isFirstAuditGuardActive(readGuard(key))) {
        clearInterval(timer);
        started.current = false;
        setStatus({ kind: 'error', message: 'الفحص طوّل أكثر من العادة.' });
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [status.kind, customerId]);

  return { status, start, retry, markDone };
}

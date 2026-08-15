import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Identity } from './auth/session.js';

export interface AuditEntry {
  at: string;
  actor: { sub: string; username: string; email: string | null };
  action: string;
  target: string | null;
  params: Record<string, unknown>;
  outcome: 'success' | 'failure';
  error?: string;
  durationMs: number;
  requestId: string;
}

/**
 * Append-only JSONL. Append-only is a feature here rather than a limitation: an
 * audit trail the application can rewrite is not much of an audit trail. Rotation
 * is left to logrotate.
 *
 * Nothing that reaches this file may contain a registration or removal token. The
 * call sites pass tokens separately from `params` for exactly that reason.
 */
export class AuditLog {
  #ready: Promise<void> | null = null;

  constructor(private readonly path: string) {}

  async #ensureDir(): Promise<void> {
    this.#ready ??= mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    return this.#ready;
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.#ensureDir();
    try {
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      // An unwritable audit log must be loud. It must not, however, take down the
      // console — losing visibility of a completed action is worse than logging late.
      console.error('[audit] failed to write entry', {
        action: entry.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Most recent entries first. Reads the whole file; fine at this volume. */
  async tail(limit = 200): Promise<AuditEntry[]> {
    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch {
      return [];
    }
    try {
      const text = await handle.readFile('utf8');
      const entries: AuditEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as AuditEntry);
        } catch {
          /* skip a torn line rather than failing the whole view */
        }
      }
      return entries.slice(-limit).reverse();
    } finally {
      await handle.close();
    }
  }
}

/**
 * Wraps a mutating operation so that it is recorded whether it succeeds or fails.
 * A failed privileged action is at least as interesting as a successful one.
 */
export async function audited<T>(
  log: AuditLog,
  ctx: {
    identity: Identity;
    action: string;
    target?: string | null;
    params?: Record<string, unknown>;
    requestId: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await log.record({
      at: new Date().toISOString(),
      actor: {
        sub: ctx.identity.sub,
        username: ctx.identity.username,
        email: ctx.identity.email,
      },
      action: ctx.action,
      target: ctx.target ?? null,
      params: ctx.params ?? {},
      outcome: 'success',
      durationMs: Date.now() - started,
      requestId: ctx.requestId,
    });
    return result;
  } catch (err) {
    await log.record({
      at: new Date().toISOString(),
      actor: {
        sub: ctx.identity.sub,
        username: ctx.identity.username,
        email: ctx.identity.email,
      },
      action: ctx.action,
      target: ctx.target ?? null,
      params: ctx.params ?? {},
      outcome: 'failure',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      requestId: ctx.requestId,
    });
    throw err;
  }
}

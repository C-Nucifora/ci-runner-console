import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Identity } from './auth/session.js';

export interface AuditEntry {
  at: string;
  actor: { sub: string; username: string; email: string | null };
  action: string;
  target: string | null;
  params: Record<string, unknown>;
  outcome: 'pending' | 'success' | 'failure';
  operationId?: string;
  error?: string;
  durationMs: number;
  requestId: string;
}

const auditEntrySchema = z.object({
  at: z.iso.datetime({ offset: true }),
  actor: z.object({ sub: z.string().min(1), username: z.string(), email: z.string().nullable() }),
  action: z.string().min(1),
  target: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  outcome: z.enum(['pending', 'success', 'failure']),
  operationId: z.string().min(1).optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
  requestId: z.string(),
});

export class AuditWriteError extends Error {
  constructor(readonly operationState: 'not-started' | 'completed' | 'failed') {
    super(operationState === 'not-started'
      ? 'Audit unavailable. Operation was not started.'
      : `Operation ${operationState}, but its audit record could not be confirmed. Refresh runner state before retrying.`);
  }
}

/** JSONL written in append mode. Filesystem permissions remain the integrity boundary. */
export class AuditLog {
  #writes: Promise<void> = Promise.resolve();
  #pendingWrites = 0;
  #directoriesSynced = false;

  constructor(private readonly path: string) {}

  async record(entry: AuditEntry): Promise<void> {
    // Snapshot before queuing so a caller cannot change a pending record.
    const safe = structuredClone(entry);
    safe.params = redactParams(safe.params);
    if (safe.error !== undefined) safe.error = 'Operation failed';
    const line = `${JSON.stringify(safe)}\n`;
    await this.#append(line);
  }

  async checkWritable(): Promise<void> {
    await this.#append('');
  }

  async #append(content: string): Promise<void> {
    if (this.#pendingWrites >= 64) throw new Error('Audit write backlog is full');
    this.#pendingWrites++;
    const write = this.#writes.then(async () => {
      if (!this.#directoriesSynced) await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Audit path is not a regular file');
        await handle.chmod(0o600);
        if (content && info.size > 0) {
          const last = Buffer.alloc(1);
          const { bytesRead } = await handle.read(last, 0, 1, info.size - 1);
          if (bytesRead !== 1) throw new Error('Audit boundary could not be read');
          // Preserve torn bytes while giving this intent its own JSONL boundary.
          if (last[0] !== 0x0a) await handle.writeFile('\n');
        }
        await handle.writeFile(content);
        await handle.sync();
        // Retry the full ancestor chain until even partially created trees are durable.
        let directory = resolve(dirname(this.path));
        do {
          const dirHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
          try {
            await dirHandle.sync();
          } finally {
            await dirHandle.close();
          }
          const parent = dirname(directory);
          if (this.#directoriesSynced || parent === directory) break;
          directory = parent;
        } while (true);
        this.#directoriesSynced = true;
      } finally {
        await handle.close();
      }
    });
    this.#writes = write.catch(() => undefined);
    try {
      await write;
    } finally {
      this.#pendingWrites--;
    }
  }

  /** Most recent entries first, limited to the final MiB of the file. */
  async tail(limit = 200): Promise<AuditEntry[]> {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    limit = Math.min(limit, 500);
    await this.#writes;
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Audit path is not a regular file');
      const size = info.size;
      const start = Math.max(0, size - 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
      // Ignore an incomplete final append until it has a terminating newline.
      text = text.slice(0, text.lastIndexOf('\n') + 1);
      const entries: AuditEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = auditEntrySchema.safeParse(JSON.parse(line));
          if (!parsed.success) continue;
          const entry = parsed.data;
          entry.params = redactParams(entry.params);
          if (entry.error !== undefined) entry.error = 'Operation failed';
          entries.push(entry);
        } catch {
          /* skip a torn line rather than failing the whole view */
        }
      }
      const seen = new Set<string>();
      return entries.reverse().filter(entry => {
        if (!entry.operationId) return true;
        if (seen.has(entry.operationId)) return false;
        seen.add(entry.operationId);
        return true;
      }).slice(0, limit);
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
  const entry = structuredClone({
    actor: { sub: ctx.identity.sub, username: ctx.identity.username, email: ctx.identity.email },
    action: ctx.action,
    target: ctx.target ?? null,
    params: ctx.params ?? {},
    requestId: ctx.requestId,
    operationId: randomUUID(),
  });
  try {
    await log.checkWritable();
    // A missing outcome after this durable intent means the operation needs reconciliation.
    await log.record({ ...entry, at: new Date().toISOString(), outcome: 'pending', durationMs: 0 });
  } catch {
    throw new AuditWriteError('not-started');
  }
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    try {
      await log.record({
        ...entry, at: new Date().toISOString(), outcome: 'failure',
        error: 'Operation failed', durationMs: Math.max(0, Date.now() - started),
      });
    } catch {
      const state = err instanceof Error ? (err as Error & { operationState?: string }).operationState : undefined;
      throw new AuditWriteError(state === 'completed' || state === 'not-started' ? state : 'failed');
    }
    throw err;
  }
  try {
    await log.record({
      ...entry, at: new Date().toISOString(), outcome: 'success',
      durationMs: Math.max(0, Date.now() - started),
    });
  } catch {
    throw new AuditWriteError('completed');
  }
  return result;
}

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  // Only current runner metadata belongs in the audit trail. Unknown fields may be credentials.
  const allowed = new Set(['labels', 'scope', 'target', 'state', 'hadLocal', 'hadGitHub']);
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [
    key, allowed.has(key) && (typeof value === 'string' || typeof value === 'boolean' ||
      (key === 'labels' && Array.isArray(value) && value.every((v) => typeof v === 'string')))
      ? value : '[redacted]',
  ]));
}

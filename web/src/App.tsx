import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { AuditList, HeadroomTiles, Notice, StateBadge } from './components';
import type { AuditEntry, Inventory, Me, RunnerView } from './types';

const POLL_MS = 15_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

const ATTENTION = new Set(['orphan-github', 'orphan-local', 'unregistered', 'no-service', 'disconnected']);

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ name: string; lines: string[] } | null>(null);

  const refresh = useCallback(async (opts: { quiet?: boolean } = {}) => {
    try {
      const [inv, aud] = await Promise.all([api.inventory(), api.audit(25)]);
      setInventory(inv);
      setAudit(aud.entries);
      if (!opts.quiet) setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError({
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ApiError ? err.hint : undefined,
      });
    }
  }, []);

  useEffect(() => {
    api.me().then(setMe).catch(() => undefined);
    void refresh();
    const timer = setInterval(() => void refresh({ quiet: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Wraps a mutation so the button disables, errors surface, and state re-reads. */
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, success: string) => {
      setBusy(key);
      setError(null);
      setFlash(null);
      try {
        await fn();
        setFlash(success);
        await refresh();
      } catch (err) {
        setError({
          message: err instanceof Error ? err.message : String(err),
          hint: err instanceof ApiError ? err.hint : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const showLogs = useCallback(async (name: string) => {
    setBusy(`logs:${name}`);
    try {
      const { lines } = await api.logs(name);
      setLogs({ name, lines });
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <h1>CI Runners</h1>
        {me ? (
          <div className="who">
            <span>
              Signed in as <strong>{me.user.name || me.user.username}</strong>
            </span>
            <button
              className="link"
              onClick={async () => {
                const { endSessionUrl } = await api.logout();
                window.location.href = endSessionUrl ?? '/';
              }}
            >
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      <p className="subtitle">
        Self-hosted runner instances on the CI VM, managing{' '}
        <code>{inventory?.target ?? me?.target ?? '…'}</code>. Each instance runs one job at a time.
      </p>

      {error ? (
        <Notice tone="error" hint={error.hint}>
          {error.message}
        </Notice>
      ) : null}
      {flash ? <Notice tone="success">{flash}</Notice> : null}
      {inventory?.warnings.map((w) => (
        <Notice key={w} tone="warning">
          {w}
        </Notice>
      ))}

      {inventory ? (
        <section>
          <h2>VM headroom</h2>
          <HeadroomTiles
            headroom={inventory.headroom}
            cap={inventory.cap}
            runners={inventory.runners}
          />
        </section>
      ) : null}

      <section>
        <h2>Runners</h2>
        <div className="card">
          <RunnerTable
            inventory={inventory}
            busy={busy}
            onAction={(name, action) =>
              run(
                `${action}:${name}`,
                () => api[action](name),
                `${name} ${action === 'stop' ? 'stopped' : `${action}ed`}.`,
              )
            }
            onDelete={(name) =>
              run(
                `delete:${name}`,
                () => api.remove(name),
                `${name} removed from the VM and deregistered from GitHub.`,
              )
            }
            onLogs={showLogs}
          />
        </div>
      </section>

      <section>
        <h2>Add a runner</h2>
        <div className="card">
          <AddRunnerForm
            inventory={inventory}
            defaultLabels={me?.defaultLabels ?? []}
            busy={busy === 'create'}
            onCreate={(name, labels) =>
              run(
                'create',
                async () => {
                  const res = await api.create(name, labels);
                  if (!res.confirmedInGitHub) {
                    throw new Error(
                      `${name} was created on the VM but has not appeared online in GitHub yet ` +
                        `(status: ${res.githubStatus}). Check its logs before relying on it.`,
                    );
                  }
                },
                `${name} is registered and online in GitHub.`,
              )
            }
          />
        </div>
      </section>

      <section>
        <h2>Audit log</h2>
        <div className="card">
          <AuditList entries={audit} />
        </div>
      </section>

      {logs ? <LogDialog name={logs.name} lines={logs.lines} onClose={() => setLogs(null)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ table */

function RunnerTable({
  inventory,
  busy,
  onAction,
  onDelete,
  onLogs,
}: {
  inventory: Inventory | null;
  busy: string | null;
  onAction: (name: string, action: 'start' | 'stop' | 'restart') => void;
  onDelete: (name: string) => void;
  onLogs: (name: string) => void;
}) {
  if (!inventory) return <div className="empty">Loading…</div>;
  if (inventory.runners.length === 0) {
    return <div className="empty">No runners yet. Add one below.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Runner</th>
          <th>State</th>
          <th>Labels</th>
          <th>Service</th>
          <th style={{ textAlign: 'right' }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {inventory.runners.map((r) => (
          <RunnerRow
            key={r.name}
            runner={r}
            busy={busy}
            onAction={onAction}
            onDelete={onDelete}
            onLogs={onLogs}
          />
        ))}
      </tbody>
    </table>
  );
}

function RunnerRow({
  runner: r,
  busy,
  onAction,
  onDelete,
  onLogs,
}: {
  runner: RunnerView;
  busy: string | null;
  onAction: (name: string, action: 'start' | 'stop' | 'restart') => void;
  onDelete: (name: string) => void;
  onLogs: (name: string) => void;
}) {
  const anyBusy = busy !== null;
  return (
    <tr className={ATTENTION.has(r.state) ? 'attention' : undefined}>
      <td>
        <div className="runner-name">
          {r.name}
          {r.protectedRunner ? <span className="chip">protected</span> : null}
        </div>
        <div className="runner-detail">{r.detail}</div>
      </td>
      <td>
        <StateBadge state={r.state} />
      </td>
      <td>
        <div className="labels">
          {(r.github?.labels ?? []).map((l) => (
            <span className="chip" key={l}>
              {l}
            </span>
          ))}
          {!r.github ? <span className="mono">—</span> : null}
        </div>
      </td>
      <td>
        <div className="mono">{r.local?.unit ?? 'no unit'}</div>
        <div className="mono">
          {r.local ? `${r.local.active ?? 'unknown'} · ${r.local.enabled ?? 'not enabled'}` : 'not on this VM'}
        </div>
      </td>
      <td>
        {r.protectedRunner ? (
          // Four disabled buttons say less than one sentence, and they wrap the
          // column onto three ragged lines.
          <div className="actions">
            <span className="mono">not managed here</span>
          </div>
        ) : (
        <div className="actions">
          {r.local?.unit ? (
            <button onClick={() => onLogs(r.name)} disabled={anyBusy}>
              Logs
            </button>
          ) : null}
          <button onClick={() => onAction(r.name, 'start')} disabled={anyBusy || !r.actions.start}>
            Start
          </button>
          <button onClick={() => onAction(r.name, 'stop')} disabled={anyBusy || !r.actions.stop}>
            Stop
          </button>
          <button onClick={() => onAction(r.name, 'restart')} disabled={anyBusy || !r.actions.restart}>
            Restart
          </button>
          <button
            className="danger"
            disabled={anyBusy || !r.actions.delete}
            onClick={() => {
              const extra = r.github
                ? 'It will be stopped, removed from the VM, and deregistered from GitHub.'
                : 'It will be removed from the VM.';
              if (window.confirm(`Delete runner "${r.name}"?\n\n${extra}`)) onDelete(r.name);
            }}
          >
            Delete
          </button>
        </div>
        )}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------- form */

function AddRunnerForm({
  inventory,
  defaultLabels,
  busy,
  onCreate,
}: {
  inventory: Inventory | null;
  defaultLabels: string[];
  busy: boolean;
  onCreate: (name: string, labels: string[]) => void;
}) {
  const [name, setName] = useState('');
  const [labels, setLabels] = useState('');

  const atCap = inventory ? !inventory.cap.canCreate : false;
  const duplicate = Boolean(inventory?.runners.some((r) => r.name === name));
  const badName = name.length > 0 && !NAME_RE.test(name);

  let blocker: string | null = null;
  if (atCap) {
    blocker = `This VM is at its limit of ${inventory?.cap.limit} runner instances. Delete one before adding another.`;
  } else if (badName) {
    blocker = 'Use letters, digits, dot, dash or underscore, starting with a letter or digit.';
  } else if (duplicate) {
    blocker = `A runner named ${name} already exists — names must be unique.`;
  }

  return (
    <form
      className="add-runner"
      onSubmit={(e) => {
        e.preventDefault();
        if (blocker || !name) return;
        onCreate(
          name,
          labels
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        setName('');
        setLabels('');
      }}
    >
      <div className="field">
        <label htmlFor="runner-name">Name</label>
        <input
          id="runner-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ci-runner-2"
          autoComplete="off"
          disabled={busy || atCap}
        />
        <span className="hint">Must be unique across the target.</span>
      </div>

      <div className="field">
        <label htmlFor="runner-labels">Extra labels</label>
        <input
          id="runner-labels"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          placeholder="comma,separated"
          autoComplete="off"
          disabled={busy || atCap}
        />
        <span className="hint">
          {defaultLabels.length > 0
            ? `Always applied: ${defaultLabels.join(', ')}`
            : 'self-hosted, Linux and X64 are added automatically.'}
        </span>
      </div>

      <button className="primary" type="submit" disabled={busy || atCap || !name || Boolean(blocker)}>
        {busy ? 'Creating…' : 'Add runner'}
      </button>

      {busy ? <span className="spin">Registering and waiting for GitHub to report it online…</span> : null}
      {blocker && !busy ? <span className="spin">{blocker}</span> : null}
    </form>
  );
}

/* ----------------------------------------------------------------- dialog */

function LogDialog({ name, lines, onClose }: { name: string; lines: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}>
      <h3>{name} — service log</h3>
      <pre className="logs">{lines.length ? lines.join('\n') : 'No log lines returned.'}</pre>
      <div className="dialog-actions">
        <button
          onClick={() => {
            ref.current?.close();
            onClose();
          }}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}

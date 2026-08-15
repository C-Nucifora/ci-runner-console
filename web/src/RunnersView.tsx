import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ATTENTION_STATES, Banner, HeadroomStrip, Section, STATE, StateBadge } from './components';
import type { Inventory, Me, RunnerView } from './types';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** GitHub adds these itself; showing them as ordinary labels implies we chose them. */
const AUTOMATIC_LABELS = new Set(['self-hosted', 'Linux', 'X64', 'Windows', 'macOS', 'ARM64']);

export type Action = 'start' | 'stop' | 'restart';

interface Props {
  inventory: Inventory | null;
  me: Me | null;
  busy: string | null;
  onAction: (name: string, action: Action) => void;
  onDelete: (name: string) => void;
  onCreate: (name: string, labels: string[]) => Promise<void>;
}

export function RunnersView({ inventory, me, busy, onAction, onDelete, onCreate }: Props) {
  const [adding, setAdding] = useState(false);
  const [logs, setLogs] = useState<{ name: string; lines: string[] } | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  const groups = useMemo(() => groupRunners(inventory?.runners ?? []), [inventory]);
  const counts = useMemo(() => countStates(inventory?.runners ?? []), [inventory]);

  async function showLogs(name: string) {
    setLogError(null);
    try {
      const { lines } = await api.logs(name);
      setLogs({ name, lines });
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!inventory) {
    return (
      <div className="card">
        <div className="empty">Loading runners…</div>
      </div>
    );
  }

  const attention = groups.attention;

  return (
    <>
      {/* Problems get their own region above everything, so they are never something
          you have to scan a table to notice. */}
      {attention.length > 0 ? (
        <Banner
          tone={attention.some((r) => STATE[r.state].tone === 'critical') ? 'critical' : 'warning'}
          hint="A runner is out of step between GitHub and the CI VM. Each one is listed below with what to do about it."
        >
          <strong>
            {attention.length} runner{attention.length === 1 ? '' : 's'} need
            {attention.length === 1 ? 's' : ''} attention
          </strong>
        </Banner>
      ) : null}

      {inventory.warnings.map((w) => (
        <Banner key={w} tone="warning">
          {w}
        </Banner>
      ))}

      {logError ? (
        <Banner tone="critical" hint={logError}>
          Could not read the service log
        </Banner>
      ) : null}

      <div className="card summary">
        <span className="stat">
          <span className="dot" style={{ background: 'var(--status-good)' }} />
          <b>{counts.online}</b> online
        </span>
        <span className="stat">
          <span className="dot" style={{ background: 'var(--seq-fill)' }} />
          <b>{counts.busy}</b> busy
        </span>
        <span className="stat">
          <span className="dot" style={{ background: 'var(--baseline)' }} />
          <b>{counts.stopped}</b> stopped
        </span>
        <span className="stat">
          <span className="dot" style={{ background: 'var(--status-warning)' }} />
          <b>{counts.attention}</b> need attention
        </span>

        <span className="spacer" />

        <span className="capacity-pill" data-full={!inventory.cap.canCreate}>
          <span className="bar">
            <span
              style={{
                width: `${Math.min(100, (inventory.cap.used / Math.max(1, inventory.cap.limit)) * 100)}%`,
              }}
            />
          </span>
          {inventory.cap.used} of {inventory.cap.limit} slots
        </span>

        <button
          className="btn primary"
          onClick={() => setAdding(true)}
          disabled={!inventory.cap.canCreate || busy !== null}
          title={
            inventory.cap.canCreate
              ? 'Register another runner instance on the CI VM'
              : `The VM is at its limit of ${inventory.cap.limit} instances`
          }
        >
          Add runner
        </button>
      </div>

      <Section title="VM headroom">
        <HeadroomStrip headroom={inventory.headroom} />
      </Section>

      {groups.ordered.map(([title, runners]) =>
        runners.length === 0 ? null : (
          <Section key={title} title={title} count={runners.length}>
            <div className="runner-list">
              {runners.map((r) => (
                <RunnerCard
                  key={r.name}
                  runner={r}
                  busy={busy}
                  onAction={onAction}
                  onDelete={onDelete}
                  onLogs={showLogs}
                />
              ))}
            </div>
          </Section>
        ),
      )}

      {inventory.runners.length === 0 ? (
        <div className="card">
          <div className="empty">
            <strong>No runners yet</strong>
            Add one to start accepting jobs on this CI VM.
          </div>
        </div>
      ) : null}

      {adding ? (
        <AddRunnerDialog
          inventory={inventory}
          defaultLabels={me?.defaultLabels ?? []}
          onClose={() => setAdding(false)}
          onCreate={onCreate}
        />
      ) : null}

      {logs ? <LogDialog name={logs.name} lines={logs.lines} onClose={() => setLogs(null)} /> : null}
    </>
  );
}

/* --------------------------------------------------------------- grouping */

function groupRunners(runners: RunnerView[]) {
  const attention: RunnerView[] = [];
  const active: RunnerView[] = [];
  const stopped: RunnerView[] = [];
  const unmanaged: RunnerView[] = [];

  for (const r of runners) {
    if (r.protectedRunner) unmanaged.push(r);
    else if (ATTENTION_STATES.includes(r.state)) attention.push(r);
    else if (r.state === 'online' || r.state === 'busy') active.push(r);
    else stopped.push(r);
  }

  const byRank = (a: RunnerView, b: RunnerView) =>
    STATE[a.state].rank - STATE[b.state].rank || a.name.localeCompare(b.name);
  attention.sort(byRank);
  active.sort(byRank);
  stopped.sort(byRank);

  return {
    attention,
    ordered: [
      ['Needs attention', attention],
      ['Active', active],
      ['Stopped', stopped],
      ['Not managed here', unmanaged],
    ] as [string, RunnerView[]][],
  };
}

function countStates(runners: RunnerView[]) {
  let online = 0;
  let busy = 0;
  let stopped = 0;
  let attention = 0;
  for (const r of runners) {
    if (r.protectedRunner) continue;
    if (ATTENTION_STATES.includes(r.state)) attention++;
    else if (r.state === 'busy') busy++;
    else if (r.state === 'online') online++;
    else if (r.state === 'stopped') stopped++;
  }
  return { online, busy, stopped, attention };
}

/* ------------------------------------------------------------ runner card */

function RunnerCard({
  runner: r,
  busy,
  onAction,
  onDelete,
  onLogs,
}: {
  runner: RunnerView;
  busy: string | null;
  onAction: (name: string, action: Action) => void;
  onDelete: (name: string) => void;
  onLogs: (name: string) => void;
}) {
  const anyBusy = busy !== null;
  const tone = STATE[r.state].tone;
  const attention = ATTENTION_STATES.includes(r.state) && !r.protectedRunner;

  return (
    <article
      className="runner"
      data-attention={attention ? (tone === 'critical' ? 'critical' : 'true') : undefined}
    >
      <div>
        <StateBadge state={r.state} />
      </div>

      <div className="identity">
        <div className="name">
          {r.name}
          {r.protectedRunner ? <span className="chip" style={{ marginLeft: '0.4rem' }}>protected</span> : null}
        </div>
        <div className="detail">{r.detail}</div>
        <div className="facts">
          {(r.github?.labels ?? []).map((l) => (
            <span className="chip" data-auto={AUTOMATIC_LABELS.has(l)} key={l}>
              {l}
            </span>
          ))}
          {r.local?.unit ? (
            <span className="unit">
              {r.local.unit} · {r.local.active ?? 'unknown'} ·{' '}
              {r.local.enabled === 'enabled' ? 'starts on boot' : 'not enabled'}
            </span>
          ) : (
            <span className="unit">{r.local ? 'no systemd unit' : 'not present on the VM'}</span>
          )}
        </div>
      </div>

      <div className="actions">
        {r.protectedRunner ? (
          <span className="unit">not managed here</span>
        ) : (
          <>
            {r.local?.unit ? (
              <button className="btn" onClick={() => onLogs(r.name)} disabled={anyBusy}>
                Logs
              </button>
            ) : null}
            {r.actions.start ? (
              <button className="btn" onClick={() => onAction(r.name, 'start')} disabled={anyBusy}>
                Start
              </button>
            ) : null}
            {r.actions.stop ? (
              <button className="btn" onClick={() => onAction(r.name, 'stop')} disabled={anyBusy}>
                Stop
              </button>
            ) : null}
            {r.actions.restart ? (
              <button className="btn" onClick={() => onAction(r.name, 'restart')} disabled={anyBusy}>
                Restart
              </button>
            ) : null}
            {r.actions.delete ? (
              <button
                className="btn danger"
                disabled={anyBusy}
                onClick={() => {
                  const what = r.github
                    ? 'It will be stopped, removed from the VM, and deregistered from GitHub.'
                    : 'It will be removed from the VM.';
                  if (window.confirm(`Delete "${r.name}"?\n\n${what}`)) onDelete(r.name);
                }}
              >
                Delete
              </button>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

/* ----------------------------------------------------------- add dialog */

function AddRunnerDialog({
  inventory,
  defaultLabels,
  onClose,
  onCreate,
}: {
  inventory: Inventory;
  defaultLabels: string[];
  onClose: () => void;
  onCreate: (name: string, labels: string[]) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [labels, setLabels] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const duplicate = inventory.runners.some((r) => r.name === name);
  const badName = name.length > 0 && !NAME_RE.test(name);
  const problem = badName
    ? 'Use letters, digits, dot, dash or underscore, starting with a letter or digit.'
    : duplicate
      ? `A runner named ${name} already exists — names must be unique, and reusing one would take over its registration.`
      : null;

  const close = () => {
    ref.current?.close();
    onClose();
  };

  return (
    <dialog ref={ref} onCancel={close} onClose={onClose}>
      <form
        method="dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (problem || !name || submitting) return;
          setSubmitting(true);
          try {
            await onCreate(
              name,
              labels.split(',').map((s) => s.trim()).filter(Boolean),
            );
            close();
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <div className="dialog-head">
          <h3>Add a runner</h3>
          <p>
            Registers a new instance on the CI VM and waits for GitHub to report it online.{' '}
            {inventory.cap.remaining} slot{inventory.cap.remaining === 1 ? '' : 's'} remaining.
          </p>
        </div>

        <div className="dialog-body">
          <div className="field">
            <label htmlFor="rname">Name</label>
            <input
              id="rname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-runner-2"
              autoComplete="off"
              autoFocus
              disabled={submitting}
              aria-invalid={Boolean(problem)}
            />
            <span className="hint" data-error={Boolean(problem)}>
              {problem ?? 'Must be unique across the target.'}
            </span>
          </div>

          <div className="field">
            <label htmlFor="rlabels">Extra labels</label>
            <input
              id="rlabels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="gpu, large  (optional)"
              autoComplete="off"
              disabled={submitting}
            />
            <span className="hint">
              {defaultLabels.length > 0
                ? `self-hosted, Linux and X64 are added by GitHub. Always applied here: ${defaultLabels.join(', ')}.`
                : 'self-hosted, Linux and X64 are added by GitHub automatically.'}
            </span>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close} disabled={submitting}>
            Cancel
          </button>
          <button className="btn primary" type="submit" disabled={submitting || !name || Boolean(problem)}>
            {submitting ? 'Creating…' : 'Add runner'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function LogDialog({ name, lines, onClose }: { name: string; lines: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const close = () => {
    ref.current?.close();
    onClose();
  };
  return (
    <dialog ref={ref} onCancel={close} onClose={onClose}>
      <div className="dialog-head">
        <h3>{name}</h3>
        <p>Last {lines.length} lines from the runner's systemd service.</p>
      </div>
      <div className="dialog-body">
        <pre className="logs">{lines.length ? lines.join('\n') : 'No log lines returned.'}</pre>
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}

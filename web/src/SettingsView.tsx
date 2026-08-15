import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Banner, Section } from './components';
import type { AuditEntry, HealthCheck, Me, SettingsGroup } from './types';

export function SettingsView({ me }: { me: Me | null }) {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [groups, setGroups] = useState<SettingsGroup[] | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function load(probe: boolean) {
    setError(null);
    if (probe) setChecking(true);
    try {
      const [s, a] = await Promise.all([api.settings(), api.audit(300)]);
      setGroups(s.groups);
      setEntries(a.entries);
      if (probe) {
        const h = await api.health();
        setChecks(h.checks);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void load(true);
    // Health probes hit GitHub and SSH, so they run on demand rather than on a timer.
  }, []);

  const failing = checks?.filter((c) => !c.ok) ?? [];

  return (
    <>
      {error ? <Banner tone="critical">{error}</Banner> : null}
      {failing.length > 0 ? (
        <Banner
          tone="critical"
          hint="Until this is resolved the console cannot fully manage runners."
        >
          <strong>
            {failing.length} of {checks?.length} dependencies are failing
          </strong>
        </Banner>
      ) : null}

      <Section
        title="Health"
        aside={
          <button className="btn" onClick={() => void load(true)} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        }
      >
        <div className="settings-grid">
          {(checks ?? []).map((c) => (
            <div className="card health" key={c.id}>
              <div className="head">
                <span className="badge" data-tone={c.ok ? 'good' : 'critical'}>
                  <span className="dot" aria-hidden="true" />
                  <span aria-hidden="true">{c.ok ? '✓' : '✕'}</span>
                  {c.ok ? 'OK' : 'Failing'}
                </span>
                <h3>{c.label}</h3>
              </div>
              <div className="detail">{c.detail}</div>
              <dl>
                {c.facts.map((f) => (
                  <div key={f.label} style={{ display: 'contents' }}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          {checks === null ? (
            <div className="card">
              <div className="empty">Running checks…</div>
            </div>
          ) : null}
        </div>
      </Section>

      <Section title="Configuration">
        <div className="settings-grid">
          {(groups ?? []).map((g) => (
            <div className="card setting-group" key={g.title}>
              <h3>{g.title}</h3>
              {g.description ? <p className="blurb">{g.description}</p> : null}
              {g.rows.map((r) => (
                <div className="setting-row" key={r.label} data-mismatch={r.mismatch || undefined}>
                  <div className="k">{r.label}</div>
                  <div>
                    <div className="v">{r.value}</div>
                    {r.env ? <span className="env">{r.env}</span> : null}
                    {r.note ? <div className="note">{r.note}</div> : null}
                    {r.mismatch ? (
                      <div className="note" style={{ color: 'var(--status-critical)' }}>
                        Does not match the console's own cap — the lower of the two applies.
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="blurb" style={{ marginTop: '0.7rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
          These values are read from the environment at start-up and are deliberately not
          editable here — changing one means editing the environment file on the host and
          restarting, so there is exactly one source of truth.
        </p>
      </Section>

      <Section title="Your access">
        <div className="card setting-group">
          <div className="setting-row">
            <div className="k">Signed in as</div>
            <div>
              <div className="v">{me?.user.username ?? '—'}</div>
              {me?.user.email ? <div className="note">{me.user.email}</div> : null}
            </div>
          </div>
          <div className="setting-row">
            <div className="k">Groups</div>
            <div className="v">{me?.user.groups.join(', ') || 'none'}</div>
          </div>
        </div>
      </Section>

      <AuditSection entries={entries} />
    </>
  );
}

/* ----------------------------------------------------------------- audit */

function AuditSection({ entries }: { entries: AuditEntry[] }) {
  const [action, setAction] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [q, setQ] = useState('');

  const actions = useMemo(
    () => ['all', ...Array.from(new Set(entries.map((e) => e.action))).sort()],
    [entries],
  );

  const filtered = entries.filter((e) => {
    if (action !== 'all' && e.action !== action) return false;
    if (outcome !== 'all' && e.outcome !== outcome) return false;
    if (q) {
      const hay = `${e.actor.username} ${e.target ?? ''} ${e.action} ${e.error ?? ''}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <Section title="Audit log" count={filtered.length}>
      <div className="card">
        <div className="audit-controls">
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
            {actions.map((a) => (
              <option key={a} value={a}>
                {a === 'all' ? 'All actions' : a}
              </option>
            ))}
          </select>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Filter by outcome">
            <option value="all">Any outcome</option>
            <option value="success">Success only</option>
            <option value="failure">Failures only</option>
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search runner or user…"
            aria-label="Search the audit log"
          />
          <span style={{ marginLeft: 'auto', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
            Append-only · every mutation, including failures
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="empty">
            <strong>Nothing matches</strong>
            {entries.length === 0 ? 'No actions have been recorded yet.' : 'Try widening the filters.'}
          </div>
        ) : (
          <ul className="audit-list">
            {filtered.map((e) => (
              <li key={`${e.at}-${e.requestId}`}>
                <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                <span className="who">{e.actor.username}</span>
                <span className="what">
                  {e.action}
                  {e.target ? ` → ${e.target}` : ''}
                  <span style={{ color: 'var(--text-muted)' }}> · {Math.round(e.durationMs)}ms</span>
                </span>
                <span className="badge" data-tone={e.outcome === 'success' ? 'good' : 'critical'}>
                  <span className="dot" aria-hidden="true" />
                  <span aria-hidden="true">{e.outcome === 'success' ? '✓' : '✕'}</span>
                  {e.outcome}
                </span>
                {e.error ? <span className="err">{e.error}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

import type { ReactNode } from 'react';
import type { AuditEntry, Headroom, RunnerState, RunnerView } from './types';

/* ------------------------------------------------------------------ state */

type Tone = 'good' | 'busy' | 'warning' | 'critical' | 'idle';

const STATE_PRESENTATION: Record<RunnerState, { tone: Tone; glyph: string; label: string }> = {
  online: { tone: 'good', glyph: '●', label: 'Online' },
  busy: { tone: 'busy', glyph: '◐', label: 'Running a job' },
  stopped: { tone: 'idle', glyph: '■', label: 'Stopped' },
  disconnected: { tone: 'warning', glyph: '▲', label: 'Disconnected' },
  'no-service': { tone: 'warning', glyph: '▲', label: 'No service' },
  unregistered: { tone: 'warning', glyph: '▲', label: 'Unregistered' },
  'orphan-github': { tone: 'critical', glyph: '✕', label: 'Orphan in GitHub' },
  'orphan-local': { tone: 'critical', glyph: '✕', label: 'Orphan on VM' },
};

export function StateBadge({ state }: { state: RunnerState }) {
  const p = STATE_PRESENTATION[state];
  return (
    <span className="badge" data-tone={p.tone} title={state}>
      <span className="dot" aria-hidden="true" />
      <span aria-hidden="true">{p.glyph}</span>
      {p.label}
    </span>
  );
}

/* ------------------------------------------------------------ stat tiles */

export function Tile({
  label,
  value,
  of,
  foot,
  meter,
}: {
  label: string;
  value: ReactNode;
  of?: string;
  foot?: string;
  meter?: { fraction: number; severity: 'normal' | 'warning' | 'critical' };
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {of ? <span className="of"> {of}</span> : null}
      </div>
      {meter ? (
        <div
          className="meter"
          data-severity={meter.severity === 'normal' ? undefined : meter.severity}
          role="meter"
          aria-valuenow={Math.round(meter.fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        >
          <span style={{ width: `${Math.min(100, Math.max(0, meter.fraction * 100)).toFixed(1)}%` }} />
        </div>
      ) : null}
      {foot ? <div className="foot">{foot}</div> : null}
    </div>
  );
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** More used means more severe, so the meters escalate rather than just growing. */
function severity(usedFraction: number): 'normal' | 'warning' | 'critical' {
  if (usedFraction >= 0.9) return 'critical';
  if (usedFraction >= 0.75) return 'warning';
  return 'normal';
}

export function HeadroomTiles({
  headroom,
  cap,
  runners,
}: {
  headroom: Headroom;
  cap: { limit: number; used: number; remaining: number };
  runners: RunnerView[];
}) {
  const memUsed = headroom.memory.totalBytes
    ? 1 - headroom.memory.availableBytes / headroom.memory.totalBytes
    : 0;
  const diskUsed = headroom.disk.totalBytes
    ? 1 - headroom.disk.freeBytes / headroom.disk.totalBytes
    : 0;
  const loadFraction = headroom.cpus ? headroom.load.one / headroom.cpus : 0;

  const online = runners.filter((r) => r.state === 'online' || r.state === 'busy').length;
  const busy = runners.filter((r) => r.state === 'busy').length;

  return (
    <div className="kpi-row">
      <Tile
        label="Runner instances"
        value={cap.used}
        of={`/ ${cap.limit}`}
        foot={cap.remaining > 0 ? `${cap.remaining} slot${cap.remaining === 1 ? '' : 's'} left` : 'At capacity'}
        meter={{ fraction: cap.limit ? cap.used / cap.limit : 0, severity: severity(cap.limit ? cap.used / cap.limit : 0) }}
      />
      <Tile
        label="Connected to GitHub"
        value={online}
        foot={busy > 0 ? `${busy} running a job` : 'None currently busy'}
      />
      {/* The total goes in the footer rather than beside the value: at display size
          "0.8 GiB / 11.7 GiB" wraps mid-unit and leaves the tiles ragged. */}
      <Tile
        label="Memory in use"
        value={gb(headroom.memory.totalBytes - headroom.memory.availableBytes)}
        foot={`of ${gb(headroom.memory.totalBytes)}`}
        meter={{ fraction: memUsed, severity: severity(memUsed) }}
      />
      <Tile
        label="Disk in use"
        value={gb(headroom.disk.totalBytes - headroom.disk.freeBytes)}
        foot={`of ${gb(headroom.disk.totalBytes)}`}
        meter={{ fraction: diskUsed, severity: severity(diskUsed) }}
      />
      <Tile
        label="Load average"
        value={headroom.load.one.toFixed(2)}
        of={`on ${headroom.cpus} vCPU`}
        meter={{ fraction: loadFraction, severity: severity(loadFraction) }}
        foot={`5 min ${headroom.load.five.toFixed(2)} · 15 min ${headroom.load.fifteen.toFixed(2)}`}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- notices */

export function Notice({
  tone,
  children,
  hint,
}: {
  tone: 'error' | 'warning' | 'success';
  children: ReactNode;
  hint?: string;
}) {
  const glyph = tone === 'error' ? '✕' : tone === 'warning' ? '▲' : '✓';
  return (
    <div className="notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="glyph" aria-hidden="true">
        {glyph}
      </span>
      <div>
        <div>{children}</div>
        {hint ? <div className="hint">{hint}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ audit */

export function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <div className="empty">No actions recorded yet.</div>;
  }
  return (
    <ul className="audit-list">
      {entries.map((e) => (
        <li key={`${e.at}-${e.requestId}`}>
          <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
          <span className="who">{e.actor.username}</span>
          <span>
            {e.action}
            {e.target ? ` → ${e.target}` : ''}
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
  );
}

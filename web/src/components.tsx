import type { ReactNode } from 'react';
import type { Headroom, RunnerState } from './types';

/* ------------------------------------------------------------------ state */

export type Tone = 'good' | 'busy' | 'warning' | 'critical' | 'idle';

interface Presentation {
  tone: Tone;
  glyph: string;
  label: string;
  /** Sort weight — the most alarming groups float to the top of the page. */
  rank: number;
}

export const STATE: Record<RunnerState, Presentation> = {
  'orphan-github': { tone: 'critical', glyph: '✕', label: 'Orphan in GitHub', rank: 0 },
  'orphan-local': { tone: 'critical', glyph: '✕', label: 'Orphan on VM', rank: 0 },
  disconnected: { tone: 'warning', glyph: '▲', label: 'Disconnected', rank: 1 },
  'no-service': { tone: 'warning', glyph: '▲', label: 'No service', rank: 1 },
  unregistered: { tone: 'warning', glyph: '▲', label: 'Unregistered', rank: 1 },
  busy: { tone: 'busy', glyph: '◐', label: 'Running a job', rank: 2 },
  online: { tone: 'good', glyph: '●', label: 'Online', rank: 3 },
  stopped: { tone: 'idle', glyph: '■', label: 'Stopped', rank: 4 },
};

export const ATTENTION_STATES: RunnerState[] = [
  'orphan-github',
  'orphan-local',
  'disconnected',
  'no-service',
  'unregistered',
];

export function StateBadge({ state }: { state: RunnerState }) {
  const p = STATE[state];
  return (
    <span className={`badge${state === 'busy' ? ' pulse' : ''}`} data-tone={p.tone} title={state}>
      <span className="dot" aria-hidden="true" />
      <span aria-hidden="true">{p.glyph}</span>
      {p.label}
    </span>
  );
}

/* --------------------------------------------------------------- notices */

export function Banner({
  tone,
  glyph,
  children,
  hint,
  action,
}: {
  tone: Tone;
  glyph?: string;
  children: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  const mark = glyph ?? (tone === 'critical' ? '✕' : tone === 'warning' ? '▲' : '✓');
  return (
    <div className="banner" data-tone={tone} role={tone === 'critical' ? 'alert' : 'status'}>
      <span className="glyph" aria-hidden="true">
        {mark}
      </span>
      <div className="body">
        <div>{children}</div>
        {hint ? <div className="hint">{hint}</div> : null}
      </div>
      {action ? <div style={{ marginLeft: 'auto' }}>{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- meters */

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** More used means more severe, so meters escalate rather than merely growing. */
export function severity(fraction: number): 'normal' | 'warning' | 'critical' {
  if (fraction >= 0.9) return 'critical';
  if (fraction >= 0.75) return 'warning';
  return 'normal';
}

function MeterCell({
  label,
  value,
  sub,
  fraction,
}: {
  label: string;
  value: string;
  sub?: string;
  fraction: number;
}) {
  const sev = severity(fraction);
  return (
    <div className="meter-cell">
      <div className="top">
        <span className="label">{label}</span>
        <span className="value">
          {value}
          {sub ? <small> {sub}</small> : null}
        </span>
      </div>
      <div
        className="meter"
        data-severity={sev === 'normal' ? undefined : sev}
        role="meter"
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span style={{ width: `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%` }} />
      </div>
    </div>
  );
}

export function HeadroomStrip({ headroom }: { headroom: Headroom }) {
  const memUsed = headroom.memory.totalBytes
    ? 1 - headroom.memory.availableBytes / headroom.memory.totalBytes
    : 0;
  const diskUsed = headroom.disk.totalBytes
    ? 1 - headroom.disk.freeBytes / headroom.disk.totalBytes
    : 0;
  const load = headroom.cpus ? headroom.load.one / headroom.cpus : 0;

  return (
    <div className="card meters">
      <MeterCell
        label="Instances"
        value={`${headroom.instances}`}
        sub={`of ${headroom.cap}`}
        fraction={headroom.cap ? headroom.instances / headroom.cap : 0}
      />
      <MeterCell
        label="Memory"
        value={gib(headroom.memory.totalBytes - headroom.memory.availableBytes)}
        sub={`of ${gib(headroom.memory.totalBytes)}`}
        fraction={memUsed}
      />
      <MeterCell
        label="Disk"
        value={gib(headroom.disk.totalBytes - headroom.disk.freeBytes)}
        sub={`of ${gib(headroom.disk.totalBytes)}`}
        fraction={diskUsed}
      />
      <MeterCell
        label="Load"
        value={headroom.load.one.toFixed(2)}
        sub={`on ${headroom.cpus} vCPU`}
        fraction={load}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- layout */

export function Section({
  title,
  count,
  aside,
  children,
}: {
  title: string;
  count?: number;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {count !== undefined ? <span className="count">{count}</span> : null}
        {aside ? <div style={{ marginLeft: 'auto' }}>{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

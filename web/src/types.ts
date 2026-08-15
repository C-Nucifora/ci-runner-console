export type RunnerState =
  | 'online'
  | 'busy'
  | 'disconnected'
  | 'stopped'
  | 'no-service'
  | 'orphan-github'
  | 'orphan-local'
  | 'unregistered';

export interface GitHubRunner {
  id: number;
  name: string;
  os: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: string[];
  runnerGroupId?: number;
}

export interface LocalInstance {
  dir: string;
  name: string;
  unit: string | null;
  registered: boolean;
  serviceInstalled: boolean;
  active: string | null;
  enabled: string | null;
  subState: string | null;
  activeSince: string | null;
  legacy: boolean;
}

export interface RunnerView {
  name: string;
  state: RunnerState;
  detail: string;
  github: GitHubRunner | null;
  local: LocalInstance | null;
  protectedRunner: boolean;
  actions: { start: boolean; stop: boolean; restart: boolean; delete: boolean };
}

export interface Headroom {
  cpus: number;
  load: { one: number; five: number; fifteen: number };
  memory: { totalBytes: number; availableBytes: number };
  disk: { totalBytes: number; freeBytes: number };
  instances: number;
  cap: number;
  remaining: number;
}

export interface Inventory {
  runners: RunnerView[];
  headroom: Headroom;
  cap: { limit: number; used: number; remaining: number; canCreate: boolean };
  target: string;
  registrationUrl: string;
  warnings: string[];
  fetchedAt: string;
}

export interface Me {
  user: { username: string; email: string | null; name: string | null; groups: string[] };
  target: string;
  cap: number;
  defaultLabels: string[];
}

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

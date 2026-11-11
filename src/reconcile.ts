import type { GitHubRunner, RunnerRegistry } from './github/registry.js';
import type { Headroom, LocalInstance, RunnerVmControl } from './vm/ctl.js';

/**
 * A runner exists in two places that can disagree. Rather than trusting either
 * side, every name seen on either side gets a row, and the row's state names the
 * disagreement explicitly. Silent divergence is exactly the failure this console
 * is meant to surface.
 */
export type RunnerState =
  /** Registered, service running, GitHub agrees it is connected. */
  | 'online'
  /** Online and currently executing a job. */
  | 'busy'
  /** Service is running locally but GitHub does not see it connected. */
  | 'disconnected'
  /** Registered with GitHub, service installed but not running. Deliberate stop. */
  | 'stopped'
  /** Registered with GitHub, present locally, but no systemd unit was ever installed. */
  | 'no-service'
  /** GitHub has a registration with nothing backing it on this VM. */
  | 'orphan-github'
  /** A registered instance on this VM that GitHub has no record of. */
  | 'orphan-local'
  /** An instance directory that was never registered with GitHub. */
  | 'unregistered';

export interface RunnerView {
  name: string;
  state: RunnerState;
  /** Plain-language explanation of the state, shown in the UI. */
  detail: string;
  github: GitHubRunner | null;
  local: LocalInstance | null;
  protectedRunner: boolean;
  actions: {
    start: boolean;
    stop: boolean;
    restart: boolean;
    delete: boolean;
  };
}

export interface Inventory {
  runners: RunnerView[];
  headroom: Headroom;
  cap: {
    limit: number;
    used: number;
    remaining: number;
    canCreate: boolean;
  };
  target: string;
  registrationUrl: string;
  githubAvailable: boolean;
  /** Non-fatal problems, e.g. GitHub unreachable while the VM answered fine. */
  warnings: string[];
  fetchedAt: string;
}

const NEEDS_ATTENTION: ReadonlySet<RunnerState> = new Set<RunnerState>([
  'orphan-github',
  'orphan-local',
  'unregistered',
  'no-service',
  'disconnected',
]);

export function needsAttention(state: RunnerState): boolean {
  return NEEDS_ATTENTION.has(state);
}

function classify(
  github: GitHubRunner | null,
  local: LocalInstance | null,
): { state: RunnerState; detail: string } {
  if (github && !local) {
    return {
      state: 'orphan-github',
      detail:
        'GitHub has a registration for this runner but no matching instance exists on the VM. ' +
        'Deleting it here will remove the stale registration.',
    };
  }

  if (!github && local) {
    if (!local.registered) {
      return {
        state: 'unregistered',
        detail:
          'An instance directory exists on the VM but was never registered with GitHub. ' +
          'It cannot pick up jobs.',
      };
    }
    return {
      state: 'orphan-local',
      detail:
        'This instance holds a registration on the VM but GitHub has no record of it. ' +
        'It was most likely removed from the GitHub side; delete it here to clean up.',
    };
  }

  if (github && local) {
    if (!local.unit || !local.serviceInstalled) {
      return {
        state: 'no-service',
        detail:
          'Registered with GitHub, but no systemd service is installed for it, so it will ' +
          'not start on boot.',
      };
    }
    // systemd is authoritative for whether the process is running. GitHub's view is
    // eventually consistent and lags a stop by some seconds, so a runner that was
    // deliberately stopped must not flash up as a fault in the meantime.
    if (local.active !== 'active') {
      return {
        state: 'stopped',
        detail:
          github.status === 'online'
            ? 'Service is stopped. GitHub has not registered the disconnect yet but will not be able to send it work.'
            : 'Service is stopped. GitHub shows it offline and will not send it work.',
      };
    }

    if (github.busy) {
      return { state: 'busy', detail: 'Currently executing a job.' };
    }
    if (github.status === 'online') {
      return { state: 'online', detail: 'Connected to GitHub and waiting for work.' };
    }
    return {
      state: 'disconnected',
      detail:
        'The service is running on the VM but GitHub does not see it connected. ' +
        'Check the runner logs for network or token errors.',
    };
  }

  // Unreachable: a name only enters the map from one side or the other.
  return { state: 'unregistered', detail: 'Unknown state.' };
}

export async function buildInventory(
  registry: RunnerRegistry,
  control: RunnerVmControl,
  opts: { cap: number; protectedNames: string[] },
): Promise<Inventory> {
  const warnings: string[] = [];

  // Query both sides concurrently, but do not let one side's outage hide the other.
  const [githubResult, localResult, headroomResult] = await Promise.allSettled([
    registry.listRunners(),
    control.list(),
    control.headroom(),
  ]);

  if (localResult.status === 'rejected') {
    throw new Error(
      `Cannot reach the runner VM: ${errText(localResult.reason)}. ` +
        'Inventory would be misleading without it, so nothing is shown.',
    );
  }

  let githubRunners: GitHubRunner[] = [];
  if (githubResult.status === 'fulfilled') {
    githubRunners = githubResult.value;
  } else {
    warnings.push(
      `GitHub could not be queried (${errText(githubResult.reason)}). ` +
        'Rows below show local state only, so registrations may be missing.',
    );
  }

  const locals = localResult.value;
  const headroom: Headroom =
    headroomResult.status === 'fulfilled'
      ? headroomResult.value
      : {
          cpus: 0,
          load: { one: 0, five: 0, fifteen: 0 },
          memory: { totalBytes: 0, availableBytes: 0 },
          disk: { totalBytes: 0, freeBytes: 0 },
          instances: locals.length,
          cap: opts.cap,
          remaining: Math.max(0, opts.cap - locals.length),
        };
  if (headroomResult.status === 'rejected') {
    warnings.push(`VM resource headroom is unavailable (${errText(headroomResult.reason)}).`);
  }

  // Routes address runners by name, so each name must have exactly one row.
  const names = new Set([...locals.map((l) => l.name), ...githubRunners.map((g) => g.name)]);
  const views: RunnerView[] = [];
  for (const name of names) {
    const matchingLocals = locals.filter((l) => l.name === name);
    const registrations = githubRunners.filter((g) => g.name === name);
    const local = matchingLocals[0] ?? null;
    const github = registrations.find((g) => g.busy) ?? registrations[0] ?? null;
    const view = makeView(name, github, local, opts.protectedNames);
    if (matchingLocals.some((l) => l.legacy)) view.protectedRunner = true;
    if (githubResult.status === 'rejected') {
      view.state = local?.active === 'active' ? 'disconnected' : 'stopped';
      view.detail = 'GitHub state unknown. Local service is ' + (local?.active ?? 'unknown') + '.';
    }
    if (registrations.length > 1) {
      view.detail += ' Multiple GitHub registrations share this name.';
      view.actions.start = view.actions.stop = view.actions.restart = false;
    }
    if (githubResult.status === 'rejected' || matchingLocals.length > 1 || view.protectedRunner) {
      view.actions = { start: false, stop: false, restart: false, delete: false };
      if (matchingLocals.length > 1) view.detail += ' Multiple local instances share this name; manual cleanup required.';
    }
    views.push(view);
  }

  views.sort((a, b) => {
    const attention = Number(needsAttention(b.state)) - Number(needsAttention(a.state));
    return attention !== 0 ? attention : a.name.localeCompare(b.name);
  });

  const used = Math.max(locals.length, headroom.instances);
  const limit = Math.min(opts.cap, headroom.cap);
  return {
    runners: views,
    headroom,
    cap: {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      canCreate: githubResult.status === 'fulfilled' && headroomResult.status === 'fulfilled' && used < limit,
    },
    target: registry.describe(),
    registrationUrl: registry.registrationUrl(),
    githubAvailable: githubResult.status === 'fulfilled',
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

function makeView(
  name: string,
  github: GitHubRunner | null,
  local: LocalInstance | null,
  protectedNames: string[],
): RunnerView {
  const { state, detail } = classify(github, local);
  // The pre-existing instance is not this console's to manage. It predates the
  // console and may be someone else's production runner.
  const isProtected = protectedNames.includes(name) || Boolean(local?.legacy);
  const hasUnit = Boolean(local?.unit && local.serviceInstalled);
  const running = local?.active === 'active';

  return {
    name,
    state,
    detail,
    github,
    local,
    protectedRunner: isProtected,
    actions: {
      start: !isProtected && !github?.busy && hasUnit && !running,
      stop: !isProtected && !github?.busy && hasUnit && running,
      restart: !isProtected && !github?.busy && hasUnit,
      // An orphan on either side must still be deletable — that is how it gets cleaned up.
      delete: !isProtected && !github?.busy && (Boolean(local) || Boolean(github)),
    },
  };
}

function errText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

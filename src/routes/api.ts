import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditLog, AuditWriteError, audited } from '../audit.js';
import type { Identity, SessionStore } from '../auth/session.js';
import type { Config } from '../config.js';
import type { GitHubCredential } from '../github/credentials.js';
import { GitHubApiError, type RunnerRegistry } from '../github/registry.js';
import { hostKeyFingerprint, runHealthChecks } from '../health.js';
import { buildInventory, type RunnerView } from '../reconcile.js';
import type { RunnerVmControl } from '../vm/ctl.js';
import { VmError } from '../vm/ssh.js';
import { SESSION_COOKIE } from './auth.js';

/** Mirrors the case statement in vm/ci-runner-ctl-ssh. Shown in Settings. */
const ALLOWLIST = [
  'list',
  'headroom',
  'status',
  'logs',
  'start',
  'stop',
  'restart',
  'create',
  'remove',
];

/** Mirrors the validation the runner VM applies, so bad input fails here with a clear message. */
const RUNNER_NAME = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const LABEL = /^[A-Za-z0-9._-]{1,39}$/;

const createRunnerBody = z.object({
  name: z
    .string()
    .trim()
    .regex(
      RUNNER_NAME,
      'Use 1-63 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.',
    ),
  labels: z.array(z.string().trim().regex(LABEL, 'Labels may use letters, digits, dot, dash and underscore only.')).max(20).default([]),
});

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
    readonly operationState?: 'not-started' | 'completed' | 'failed',
  ) {
    super(message);
  }
}

export function registerApiRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    sessions: SessionStore;
    registry: RunnerRegistry;
    credential: GitHubCredential;
    control: RunnerVmControl;
    audit: AuditLog;
  },
) {
  const { config, sessions, registry, credential, control, audit } = deps;

  // Reject overlapping mutations instead of retaining requests and stale identities.
  let mutationActive = false;
  async function mutate<T>(req: FastifyRequest, action: string, target: string | null, operation: () => Promise<T>, params: Record<string, unknown> = {}) {
    const identity = sessions.get(req.cookies[SESSION_COOKIE]);
    // Claim the slot before audit I/O so slow storage cannot queue mutations for later execution.
    const overlapping = mutationActive;
    if (!overlapping) mutationActive = true;
    try {
      return await audited(audit, {
        identity: identity ?? { sub: 'anonymous', username: 'anonymous', email: null, name: null, groups: [] },
        action, target, params, requestId: req.id,
      }, async () => {
        requireActiveRequest(req);
        requireSameOrigin(req);
        if (overlapping) throw new HttpError(409, 'Another runner mutation is in progress. Refresh and retry.');
        return operation();
      });
    } finally {
      if (!overlapping) mutationActive = false;
    }
  }

  function requireActiveRequest(req: FastifyRequest): void {
    requireIdentity(req);
    if (req.raw.aborted || req.raw.socket?.destroyed) {
      throw new HttpError(409, 'Request disconnected before the operation completed.');
    }
  }

  async function mutationInventory() {
    const result = await inventory();
    if (!result.githubAvailable) {
      throw new HttpError(503, 'GitHub state is unavailable. Refresh inventory before retrying.');
    }
    return result;
  }

  async function idleRegistrations(req: FastifyRequest, name: string, allowDuplicates = true) {
    requireActiveRequest(req);
    const matches = (await registry.listRunners()).filter((runner) => runner.name === name);
    requireActiveRequest(req);
    if (matches.some((runner) => runner.busy)) {
      throw new HttpError(409, `${name} is executing a job. Refresh inventory and retry when idle.`);
    }
    if (!allowDuplicates && matches.length > 1) {
      throw new HttpError(409, `${name} has multiple GitHub registrations. Refresh inventory before cleanup.`);
    }
    return matches;
  }

  function requireIdentity(req: FastifyRequest): Identity {
    const identity = sessions.get(req.cookies[SESSION_COOKIE]);
    if (!identity) throw new HttpError(401, 'Not signed in');
    return identity;
  }

  /**
   * Same-origin check for state-changing requests. The session cookie is SameSite=Lax,
   * which already blocks cross-site form POSTs, but Lax is a browser behaviour rather
   * than something this server can verify, so the origin is checked explicitly too.
   */
  function requireSameOrigin(req: FastifyRequest): void {
    const origin = req.headers.origin;
    if (origin !== config.publicBaseUrl) {
      throw new HttpError(403, 'Cross-origin request refused');
    }
  }

  async function inventory() {
    return buildInventory(registry, control, {
      cap: config.runners.cap,
      protectedNames: config.runners.protectedNames,
    });
  }

  function findRunner(views: RunnerView[], name: string): RunnerView {
    const view = views.find((v) => v.name === name);
    if (!view) throw new HttpError(404, `No runner named ${name}`);
    if (view.protectedRunner) {
      throw new HttpError(
        403,
        `${name} is marked as protected and cannot be changed from this console.`,
      );
    }
    return view;
  }

  app.get('/api/me', async (req) => {
    const identity = requireIdentity(req);
    return {
      user: {
        username: identity.username,
        email: identity.email,
        name: identity.name,
        groups: identity.groups,
      },
      target: registry.describe(),
      cap: config.runners.cap,
      defaultLabels: config.runners.defaultLabels,
    };
  });

  app.get('/api/inventory', async (req) => {
    requireIdentity(req);
    return inventory();
  });

  app.get('/api/audit', async (req) => {
    requireIdentity(req);
    const { limit } = req.query as { limit?: string };
    const parsed = Number.parseInt(limit ?? '100', 10);
    return { entries: await audit.tail(Number.isFinite(parsed) ? Math.min(parsed, 500) : 100) };
  });

  app.get('/api/health', async (req) => {
    requireIdentity(req);
    return { checks: await runHealthChecks({ config, credential, registry, control }) };
  });

  /**
   * Effective configuration, for operators to confirm what the running process
   * actually believes. Every row names the variable that sets it, because the
   * answer to "why is it doing that" is almost always an environment value.
   * Secrets are never included — only their shape.
   */
  app.get('/api/settings', async (req) => {
    requireIdentity(req);

    // The VM enforces its own cap independently of the app's. If they disagree the
    // stricter one silently wins, which is confusing, so surface it.
    let vmCap: number | null = null;
    try {
      vmCap = (await control.headroom()).cap;
    } catch {
      vmCap = null;
    }

    return {
      groups: [
        {
          title: 'GitHub target',
          description: 'Where runners are registered, and what this console signs in as.',
          rows: [
            { label: 'Scope', value: config.github.scope, env: 'GITHUB_SCOPE' },
            { label: 'Owner', value: config.github.owner, env: 'GITHUB_OWNER' },
            ...(config.github.repo
              ? [{ label: 'Repository', value: config.github.repo, env: 'GITHUB_REPO' }]
              : []),
            ...(config.github.runnerGroup
              ? [{ label: 'Runner group', value: config.github.runnerGroup, env: 'GITHUB_RUNNER_GROUP' }]
              : []),
            { label: 'Registration URL', value: registry.registrationUrl() },
            { label: 'Credential', value: credential.describe(), env: 'GITHUB_TOKEN' },
            { label: 'API base', value: config.github.apiBaseUrl, env: 'GITHUB_API_BASE_URL' },
          ],
        },
        {
          title: 'Capacity',
          description:
            'The cap is enforced twice — here and again on the VM. Keep them in step; the lower value wins.',
          rows: [
            { label: 'Console cap', value: String(config.runners.cap), env: 'RUNNER_CAP' },
            {
              label: 'VM cap',
              value: vmCap === null ? 'unavailable' : String(vmCap),
              note: 'MAX_RUNNERS in /etc/ci-runner-ctl.conf on the runner VM',
              mismatch: vmCap !== null && vmCap !== config.runners.cap,
            },
            {
              label: 'Default labels',
              value: config.runners.defaultLabels.join(', ') || 'none',
              env: 'RUNNER_DEFAULT_LABELS',
              note: 'Applied to every runner this console creates, on top of GitHub\'s automatic ones.',
            },
            {
              label: 'Protected runners',
              value: config.runners.protectedNames.join(', ') || 'none',
              env: 'RUNNER_PROTECTED_NAMES',
              note: 'Never started, stopped or deleted from here.',
            },
          ],
        },
        {
          title: 'Runner VM',
          description:
            'Reached over SSH with a key pinned to a fixed command allowlist. No arbitrary shell is possible from this console.',
          rows: [
            { label: 'Address', value: `${config.vm.user}@${config.vm.host}:${config.vm.port}`, env: 'RUNNER_VM_HOST' },
            { label: 'Key file', value: config.vm.privateKeyPath, env: 'RUNNER_VM_KEY_PATH' },
            {
              label: 'Pinned host key',
              value: hostKeyFingerprint(config.vm.hostKey),
              env: 'RUNNER_VM_HOST_KEY',
              note: 'Compare with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the VM.',
            },
            {
              label: 'Permitted operations',
              value: ALLOWLIST.join(', '),
              note: 'Anything outside this list is refused by the VM, not by this console.',
            },
          ],
        },
        {
          title: 'Access',
          description: 'Sign-in is real OIDC. Proxy-supplied identity headers are stripped and never trusted.',
          rows: [
            { label: 'Issuer', value: config.oidc.issuer, env: 'OIDC_ISSUER' },
            { label: 'Client ID', value: config.oidc.clientId, env: 'OIDC_CLIENT_ID' },
            {
              label: 'Permitted groups',
              value: config.oidc.allowedGroups.join(', ') || 'any authenticated user',
              env: 'OIDC_ALLOWED_GROUPS',
            },
            { label: 'Session lifetime', value: `${Math.round(config.sessionTtlSeconds / 3600)} hours`, env: 'SESSION_TTL_SECONDS' },
            { label: 'Public base URL', value: config.publicBaseUrl, env: 'PUBLIC_BASE_URL' },
          ],
        },
        {
          title: 'Audit',
          rows: [
            { label: 'Log file', value: config.auditLogPath, env: 'AUDIT_LOG_PATH' },
            {
              label: 'Retention',
              value: 'append-only, no rotation',
              note: 'Rotate with logrotate if it grows. The console never rewrites this file.',
            },
          ],
        },
      ],
    };
  });

  app.get('/api/runners/:name/logs', async (req) => {
    requireIdentity(req);
    const { name } = req.params as { name: string };
    if (!RUNNER_NAME.test(name)) throw new HttpError(400, 'Invalid runner name');
    return { lines: await control.logs(name, 200) };
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/runners/:name/${action}`, async (req) => {
      const { name } = req.params as { name: string };
      return mutate(req, `runner.${action}`, name, async () => {
        if (!RUNNER_NAME.test(name)) throw new HttpError(400, 'Invalid runner name');
        const before = await mutationInventory();
        const view = findRunner(before.runners, name);
        if (!view.actions[action]) {
          throw new HttpError(409, `${name} cannot be ${pastTense(action)} in its current state (${view.state}).`);
        }
        await idleRegistrations(req, name, false);
        try {
          const result = await control[action](name);
          return { ok: true, ...result };
        } catch {
          throw new HttpError(502, `${name} could not be confirmed ${pastTense(action)}.`,
            'The VM may have changed. Refresh inventory and check runner logs before retrying.', 'failed');
        }
      });
    });
  }

  app.post('/api/runners', async (req) => {
    const parsed = createRunnerBody.safeParse(req.body);
    return mutate(req, 'runner.create', parsed.success ? parsed.data.name : null, async () => {
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request');
      const { name } = parsed.data;
      const labels = dedupe([...config.runners.defaultLabels, ...parsed.data.labels]);
      if (labels.length > 20) throw new HttpError(400, 'Use at most 20 labels including the configured defaults.');
      if (config.runners.protectedNames.includes(name)) throw new HttpError(403, 'Runner name is protected');
      async function checkCreateInventory() {
        const before = await mutationInventory();
        requireActiveRequest(req);
        if (!before.cap.canCreate) {
          throw new HttpError(409, `Runner capacity is exhausted or unavailable (limit ${before.cap.limit}).`);
        }
        if (before.runners.some((r) => r.name === name)) {
          throw new HttpError(409, `A runner named ${name} already exists.`);
        }
      }
      await checkCreateInventory();
      const registration = await registry.createRegistrationToken();
      requireActiveRequest(req);
      await checkCreateInventory();
      let created;
      try {
        created = await control.create({
          name, labels, url: registry.registrationUrl(), runnerGroup: config.github.runnerGroup,
          registrationToken: registration.token,
        });
      } catch {
        throw new HttpError(502, `${name} creation could not be confirmed.`,
          'Partial local or GitHub state may remain. Refresh inventory and check logs before retrying or cleaning up.', 'failed');
      }
      try {
        const online = await waitForGitHub(registry, name, 60_000, () => requireActiveRequest(req));
        return { ok: true, ...created, operationState: 'completed',
          confirmedInGitHub: online?.status === 'online', githubStatus: online?.status ?? 'unknown' };
      } catch {
        throw new HttpError(502, `${name} was created on the VM, but GitHub confirmation did not complete.`,
          'Refresh inventory and check runner logs. Do not create it again or remove it until its state is known.', 'completed');
      }
    }, parsed.success ? { labels: dedupe([...config.runners.defaultLabels, ...parsed.data.labels]), scope: config.github.scope, target: registry.describe() } : {});
  });

  app.delete('/api/runners/:name', async (req) => {
    const { name } = req.params as { name: string };
    return mutate(req, 'runner.delete', name, async () => {
      if (!RUNNER_NAME.test(name)) throw new HttpError(400, 'Invalid runner name');
      const before = await mutationInventory();
      const view = findRunner(before.runners, name);
      if (!view.actions.delete) throw new HttpError(409, `${name} cannot be deleted in its current state.`);
      const steps: string[] = [];
      let started = false;
      try {
        // A local failure stops cleanup; retry from a fresh inventory.
        if (view.local) {
          await idleRegistrations(req, name);
          const removal = await registry.createRemoveToken();
          await idleRegistrations(req, name);
          started = true;
          const result = await control.remove(name, removal.token);
          steps.push(result.deregisteredLocally
            ? 'local instance removed and deregistered'
            : 'local instance removed; GitHub deregistration still needs confirmation');
        }
        const remaining = await idleRegistrations(req, name);
        for (const stale of remaining) {
          // Recheck all duplicates before each deletion, including after a slow token or API call.
          const current = await idleRegistrations(req, name);
          if (!current.some((runner) => runner.id === stale.id)) continue;
          started = true;
          await registry.deleteRunner(stale.id);
          steps.push(`GitHub registration ${stale.id} deleted`);
        }
        const after = await mutationInventory();
        const leftover = after.runners.find((r) => r.name === name);
        if (leftover) throw new HttpError(502, `${name} still appears as ${leftover.state}.`);
        return { ok: true, steps };
      } catch (err) {
        const detail = err instanceof HttpError ? ` ${err.message}` : '';
        throw new HttpError(err instanceof HttpError ? err.status : 502,
          `${name} deletion ${started ? 'could not be confirmed' : 'was not started'}.${detail}`,
          `Refresh inventory and check logs before retrying cleanup. Confirmed steps: ${steps.join('; ') || 'none'}.`,
          started ? 'failed' : 'not-started');
      }
    });
  });

  app.setErrorHandler((err, req, reply: FastifyReply) => {
    if (err instanceof AuditWriteError) {
      req.log.error({ operationState: err.operationState }, 'runner mutation audit write failed');
      return reply.code(503).send({ error: err.message, operationState: err.operationState,
        hint: err.operationState === 'not-started'
          ? 'Restore audit storage before retrying. No runner action was started.'
          : 'Restore audit storage and refresh inventory. Check runner logs before retrying; changes may already be applied.',
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.message, hint: err.hint, operationState: err.operationState });
    }
    if (err instanceof GitHubApiError) {
      req.log.warn({ err: err.message, status: err.status }, 'GitHub API error');
      return reply.code(err.status === 401 ? 502 : err.status).send({ error: err.message, hint: err.hint });
    }
    if (err instanceof VmError) {
      req.log.warn({ err: err.message }, 'runner VM error');
      return reply.code(502).send({ error: err.message });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal error' });
  });
}

async function waitForGitHub(registry: RunnerRegistry, name: string, timeoutMs: number, checkActive: () => void) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    checkActive();
    const runners = await registry.listRunners();
    checkActive();
    const matches = runners.filter((runner) => runner.name === name);
    if (matches.length > 1) throw new Error('Multiple GitHub registrations share this name');
    const found = matches[0];
    if (found?.status === 'online' || performance.now() >= deadline) return found ?? null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, deadline - performance.now())));
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function pastTense(action: 'start' | 'stop' | 'restart'): string {
  return action === 'stop' ? 'stopped' : `${action}ed`;
}

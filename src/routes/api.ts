import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditLog, audited } from '../audit.js';
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
const RUNNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
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
    if (!origin) return; // same-origin fetches from some clients omit it entirely
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
      const identity = requireIdentity(req);
      requireSameOrigin(req);
      const { name } = req.params as { name: string };
      if (!RUNNER_NAME.test(name)) throw new HttpError(400, 'Invalid runner name');

      const before = await inventory();
      const view = findRunner(before.runners, name);
      if (!view.actions[action]) {
        throw new HttpError(409, `${name} cannot be ${pastTense(action)} in its current state (${view.state}).`);
      }

      return audited(
        audit,
        { identity, action: `runner.${action}`, target: name, requestId: req.id },
        async () => {
          const result = await control[action](name);
          return { ok: true, ...result };
        },
      );
    });
  }

  app.post('/api/runners', async (req) => {
    const identity = requireIdentity(req);
    requireSameOrigin(req);

    const parsed = createRunnerBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request');
    }
    const { name } = parsed.data;
    const labels = dedupe([...config.runners.defaultLabels, ...parsed.data.labels]);

    const before = await inventory();
    if (!before.cap.canCreate) {
      throw new HttpError(
        409,
        `This VM is already at its configured limit of ${before.cap.limit} runner instances.`,
        'Raise RUNNER_CAP only if the VM has the CPU and memory to back it, or remove an existing runner first.',
      );
    }
    if (before.runners.some((r) => r.name === name)) {
      throw new HttpError(
        409,
        `A runner named ${name} already exists.`,
        'Runner names must be unique — reusing one would take over the other runner\'s registration.',
      );
    }

    return audited(
      audit,
      {
        identity,
        action: 'runner.create',
        target: name,
        // Deliberately records the labels but never the registration token.
        params: { labels, scope: config.github.scope, target: registry.describe() },
        requestId: req.id,
      },
      async () => {
        const registration = await registry.createRegistrationToken();
        const created = await control.create({
          name,
          labels,
          url: registry.registrationUrl(),
          runnerGroup: config.github.runnerGroup,
          registrationToken: registration.token,
        });

        const online = await waitForGitHub(registry, name, 60_000);
        return {
          ok: true,
          ...created,
          confirmedInGitHub: Boolean(online),
          githubStatus: online?.status ?? 'unknown',
        };
      },
    );
  });

  app.delete('/api/runners/:name', async (req) => {
    const identity = requireIdentity(req);
    requireSameOrigin(req);
    const { name } = req.params as { name: string };
    if (!RUNNER_NAME.test(name)) throw new HttpError(400, 'Invalid runner name');

    const before = await inventory();
    const view = findRunner(before.runners, name);

    return audited(
      audit,
      {
        identity,
        action: 'runner.delete',
        target: name,
        params: { state: view.state, hadLocal: Boolean(view.local), hadGitHub: Boolean(view.github) },
        requestId: req.id,
      },
      async () => {
        const steps: string[] = [];

        // Remove the local instance first, using a removal token so the runner
        // deregisters itself cleanly. If that fails we still force the GitHub side
        // below, because a half-deleted runner is worse than either extreme.
        if (view.local) {
          const removal = await registry.createRemoveToken();
          const result = await control.remove(name, removal.token);
          steps.push(
            result.deregisteredLocally
              ? 'local instance removed and deregistered'
              : 'local instance removed (self-deregistration failed; forcing via API)',
          );
        }

        // Re-read GitHub rather than trusting the pre-action snapshot: config.sh
        // remove may already have cleared the registration.
        const remaining = await registry.listRunners().catch(() => null);
        const stale = remaining?.find((r) => r.name === name) ?? null;
        if (stale) {
          await registry.deleteRunner(stale.id);
          steps.push('GitHub registration deleted');
        } else if (view.github) {
          steps.push('GitHub registration already gone');
        }

        // Prove no orphan survived on either side.
        const after = await inventory().catch(() => null);
        const leftover = after?.runners.find((r) => r.name === name) ?? null;
        if (leftover) {
          throw new Error(
            `${name} still appears as ${leftover.state} after deletion — manual cleanup needed.`,
          );
        }

        return { ok: true, steps };
      },
    );
  });

  app.setErrorHandler((err, req, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.message, hint: err.hint });
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

async function waitForGitHub(registry: RunnerRegistry, name: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runners = await registry.listRunners().catch(() => []);
    const found = runners.find((r) => r.name === name);
    if (found?.status === 'online') return found;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const runners = await registry.listRunners().catch(() => []);
  return runners.find((r) => r.name === name) ?? null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function pastTense(action: 'start' | 'stop' | 'restart'): string {
  return action === 'stop' ? 'stopped' : `${action}ed`;
}

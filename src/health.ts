import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import type { Config } from './config.js';
import type { GitHubCredential } from './github/credentials.js';
import type { RunnerRegistry } from './github/registry.js';
import type { RunnerVmControl } from './vm/ctl.js';

export interface HealthCheck {
  id: 'github' | 'runner-vm' | 'oidc';
  label: string;
  ok: boolean;
  /** One sentence a human can act on. */
  detail: string;
  /** Extra facts worth showing beside the result. */
  facts: { label: string; value: string }[];
}

/**
 * The three things this console cannot work without. Each is probed independently
 * so a single outage is reported precisely rather than as a blanket failure —
 * "GitHub token expired" and "the CI VM is off" need very different responses.
 */
export async function runHealthChecks(deps: {
  config: Config;
  credential: GitHubCredential;
  registry: RunnerRegistry;
  control: RunnerVmControl;
}): Promise<HealthCheck[]> {
  const [github, vm, oidc] = await Promise.all([
    checkGitHub(deps),
    checkRunnerVm(deps),
    checkOidc(deps),
  ]);
  return [github, vm, oidc];
}

async function checkGitHub({
  config,
  credential,
  registry,
}: {
  config: Config;
  credential: GitHubCredential;
  registry: RunnerRegistry;
}): Promise<HealthCheck> {
  const facts: { label: string; value: string }[] = [
    { label: 'Target', value: registry.describe() },
    { label: 'Credential', value: credential.describe() },
  ];

  try {
    const octokit = new Octokit({
      auth: await credential.getToken(),
      baseUrl: config.github.apiBaseUrl,
      userAgent: 'ci-runner-console',
    });

    const rate = await octokit.request('GET /rate_limit');
    const core = rate.data.resources.core;
    facts.push({
      label: 'API quota',
      value: `${core.remaining} of ${core.limit} left, resets ${new Date(core.reset * 1000).toLocaleTimeString()}`,
    });

    // Classic and OAuth tokens advertise their scopes in a response header.
    // Fine-grained tokens do not, which is itself worth reporting.
    const scopes = rate.headers['x-oauth-scopes'];
    facts.push({
      label: 'Token scopes',
      value: scopes ? String(scopes) : 'not advertised (fine-grained token)',
    });

    // Listing runners is the permission that actually matters, so prove it rather
    // than assuming a successful rate-limit call implies access.
    const runners = await registry.listRunners();
    facts.push({ label: 'Runners visible', value: String(runners.length) });

    return {
      id: 'github',
      label: 'GitHub API',
      ok: true,
      detail: `Authenticated and able to administer runners on ${registry.describe()}.`,
      facts,
    };
  } catch (err) {
    return {
      id: 'github',
      label: 'GitHub API',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      facts,
    };
  }
}

async function checkRunnerVm({
  config,
  control,
}: {
  config: Config;
  control: RunnerVmControl;
}): Promise<HealthCheck> {
  const facts = [
    {
      label: 'Host',
      value: `${config.vm.user}@${config.vm.host}:${config.vm.port}`,
    },
    { label: 'Pinned host key', value: hostKeyFingerprint(config.vm.hostKey) },
  ];

  try {
    const headroom = await control.headroom();
    facts.push(
      { label: 'Instances', value: `${headroom.instances} of ${headroom.cap}` },
      { label: 'CPU / memory', value: `${headroom.cpus} vCPU, ${gib(headroom.memory.totalBytes)} total` },
    );
    return {
      id: 'runner-vm',
      label: 'Runner VM',
      ok: true,
      detail: 'Reachable over the restricted SSH command allowlist.',
      facts,
    };
  } catch (err) {
    return {
      id: 'runner-vm',
      label: 'Runner VM',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      facts,
    };
  }
}

async function checkOidc({ config }: { config: Config }): Promise<HealthCheck> {
  const facts = [
    { label: 'Issuer', value: config.oidc.issuer },
    { label: 'Client ID', value: config.oidc.clientId },
    {
      label: 'Required group',
      value: config.oidc.allowedGroups.length
        ? config.oidc.allowedGroups.join(', ')
        : 'any authenticated user',
    },
  ];

  try {
    const base = config.oidc.issuer.replace(/\/+$/, '');
    const res = await fetch(`${base}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`discovery returned HTTP ${res.status}`);
    const meta = (await res.json()) as { jwks_uri?: string };
    if (!meta.jwks_uri) throw new Error('discovery document has no jwks_uri');

    const jwks = await fetch(meta.jwks_uri, { signal: AbortSignal.timeout(10_000) });
    if (!jwks.ok) throw new Error(`JWKS returned HTTP ${jwks.status}`);
    const keys = (await jwks.json()) as { keys?: unknown[] };
    const count = keys.keys?.length ?? 0;
    if (count === 0) {
      // Authentik signs with HS256 when no signing key is set, which this app
      // cannot verify against a published JWKS.
      throw new Error('JWKS is empty — the provider has no signing certificate set');
    }
    facts.push({ label: 'Signing keys', value: String(count) });

    return {
      id: 'oidc',
      label: 'Authentik SSO',
      ok: true,
      detail: 'Discovery and signing keys are reachable, so sign-in will work.',
      facts,
    };
  } catch (err) {
    return {
      id: 'oidc',
      label: 'Authentik SSO',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      facts,
    };
  }
}

/** Same form `ssh-keygen -lf` prints, so it can be compared by eye. */
export function hostKeyFingerprint(hostKey: string): string {
  const parts = hostKey.trim().split(/\s+/);
  const base64 = parts.length > 1 ? parts[1]! : parts[0]!;
  const digest = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

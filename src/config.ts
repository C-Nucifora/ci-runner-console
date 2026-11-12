import { readFileSync } from 'node:fs';
import ssh2 from 'ssh2';
import { z } from 'zod';

/**
 * Every secret may be supplied either directly (`FOO`) or as a path to a file
 * containing it (`FOO_FILE`). The file form is preferred in production: it keeps
 * secrets out of the process environment, where they would otherwise be readable
 * via `/proc/<pid>/environ` and would leak into any crash dump or `systemctl show`.
 */
function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  const direct = process.env[name];
  return direct === undefined || direct === '' ? undefined : direct;
}

const nonEmpty = z.string().trim().min(1);
const maxTimerMs = 2_147_483_647;
const timerMs = z.coerce.number().int().positive().max(maxTimerMs);
const githubName = z.string().trim().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
const optionalGithubName = z.union([githubName, z.literal('')]).optional();
const runnerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/)
  .refine((value) => !value.includes('..'), 'runner names cannot contain consecutive dots');

const httpUrl = z.string().url().superRefine((value, ctx) => {
  if (!URL.canParse(value)) return;
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must use HTTPS or loopback HTTP without credentials query or fragment' });
  }
});

const schema = z.object({
  host: nonEmpty.default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8080),

  /**
   * The externally reachable origin. Deliberately explicit rather than derived
   * from Host/X-Forwarded-* headers: this value ends up in the OIDC redirect URI,
   * and deriving it from attacker-controllable headers is how redirect-URI
   * confusion bugs happen.
   */
  publicBaseUrl: httpUrl.refine((value) => URL.canParse(value) && new URL(value).pathname === '/', 'must be an origin without a path')
    .transform((value) => new URL(value).origin),

  sessionSecret: nonEmpty.min(32, 'SESSION_SECRET must be at least 32 characters'),
  sessionTtlSeconds: z.coerce.number().int().positive().max(Math.floor(maxTimerMs / 1000)).default(8 * 60 * 60),

  oidc: z.object({
    issuer: httpUrl,
    clientId: nonEmpty,
    clientSecret: nonEmpty,
    /** If non-empty, the user must hold at least one of these Authentik groups. */
    allowedGroups: z.array(z.string()).default([]),
  }),

  github: z.object({
    token: nonEmpty,
    /** Repo-level runners need only `repo`; org-level needs the org runners permission. */
    scope: z.enum(['repo', 'org']),
    owner: githubName,
    repo: optionalGithubName,
    /** Org runner group to place new runners in. Ignored for repo scope. */
    runnerGroup: z.union([z.string().trim().regex(/^[A-Za-z0-9._ -]{1,64}$/), z.literal('')]).optional(),
    apiBaseUrl: httpUrl.default('https://api.github.com'),
  }),

  vm: z.object({
    host: nonEmpty,
    port: z.coerce.number().int().min(1).max(65535).default(22),
    user: nonEmpty.default('runner'),
    privateKeyPath: nonEmpty,
    /**
     * Pinned host key in OpenSSH `authorized_keys` form (`ssh-ed25519 AAAA...`).
     * Without this the first connection would trust whatever answers on the LAN,
     * and the runner VM sits on a flat network the control plane does not own.
     */
    hostKey: nonEmpty.refine((value) => {
      const key = ssh2.utils.parseKey(value);
      return !(key instanceof Error) && !Array.isArray(key) && !key.isPrivateKey();
    }, 'must be an OpenSSH public host key'),
    connectTimeoutMs: timerMs.default(15_000),
    commandTimeoutMs: timerMs.default(180_000),
  }),

  runners: z.object({
    cap: z.coerce.number().int().min(1).max(16).default(3),
    defaultLabels: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,39}$/)).max(20).default([]),
    /** Refuse to touch these names even if they appear in the inventory. */
    protectedNames: z.array(runnerName).default([]),
  }),

  auditLogPath: nonEmpty.default('/var/lib/ci-runner-console/audit.jsonl'),
  pollIntervalMs: timerMs.default(15_000),
});

export type Config = z.infer<typeof schema>;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const scope = (process.env.GITHUB_SCOPE ?? 'repo') as 'repo' | 'org';

  const parsed = schema.safeParse({
    host: process.env.HOST,
    port: process.env.PORT,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    sessionSecret: secret('SESSION_SECRET'),
    sessionTtlSeconds: process.env.SESSION_TTL_SECONDS,
    oidc: {
      issuer: process.env.OIDC_ISSUER,
      clientId: process.env.OIDC_CLIENT_ID,
      clientSecret: secret('OIDC_CLIENT_SECRET'),
      allowedGroups: list(process.env.OIDC_ALLOWED_GROUPS),
    },
    github: {
      token: secret('GITHUB_TOKEN'),
      scope,
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      runnerGroup: process.env.GITHUB_RUNNER_GROUP,
      apiBaseUrl: process.env.GITHUB_API_BASE_URL,
    },
    vm: {
      host: process.env.RUNNER_VM_HOST,
      port: process.env.RUNNER_VM_PORT,
      user: process.env.RUNNER_VM_USER,
      privateKeyPath: process.env.RUNNER_VM_KEY_PATH,
      hostKey: secret('RUNNER_VM_HOST_KEY'),
      connectTimeoutMs: process.env.RUNNER_VM_CONNECT_TIMEOUT_MS,
      commandTimeoutMs: process.env.RUNNER_VM_COMMAND_TIMEOUT_MS,
    },
    runners: {
      cap: process.env.RUNNER_CAP,
      defaultLabels: list(process.env.RUNNER_DEFAULT_LABELS),
      protectedNames: list(process.env.RUNNER_PROTECTED_NAMES),
    },
    auditLogPath: process.env.AUDIT_LOG_PATH,
    pollIntervalMs: process.env.POLL_INTERVAL_MS,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const config = parsed.data;

  if (config.github.scope === 'repo' && !config.github.repo) {
    throw new Error('GITHUB_REPO is required when GITHUB_SCOPE=repo');
  }
  if (config.github.scope === 'repo' && config.github.runnerGroup) {
    throw new Error('GITHUB_RUNNER_GROUP is only meaningful when GITHUB_SCOPE=org');
  }

  return config;
}

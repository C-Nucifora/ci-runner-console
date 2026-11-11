import { z } from 'zod';
import { Octokit } from '@octokit/rest';
import { RequestError } from '@octokit/request-error';
import type { GitHubCredential } from './credentials.js';
import type { Config } from '../config.js';

export interface GitHubRunner {
  id: number;
  name: string;
  os: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: string[];
  runnerGroupId?: number;
}

export interface ScopedToken {
  token: string;
  expiresAt: string;
}

/**
 * Runner administration, abstracted over whether the runners belong to a repo or
 * an org. The two GitHub API families are identical in shape but not in path, and
 * the account this runs as may only have repo-level rights today.
 */
export interface RunnerRegistry {
  listRunners(): Promise<GitHubRunner[]>;
  createRegistrationToken(): Promise<ScopedToken>;
  createRemoveToken(): Promise<ScopedToken>;
  deleteRunner(runnerId: number): Promise<void>;
  /** The `--url` value `config.sh` should register against. */
  registrationUrl(): string;
  /** Short description of what this registry manages, for the UI and audit log. */
  describe(): string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function wrap(err: unknown, action: string): never {
  if (err instanceof RequestError) {
    let hint: string | undefined;
    if (err.status === 403) {
      hint =
        'The credential lacks self-hosted runner administration rights on this target. ' +
        'For an org this is the "Self-hosted runners" organization permission, which only ' +
        'an org owner can grant; for a repo it is admin access.';
    } else if (err.status === 404) {
      hint =
        'Either the target does not exist or the credential cannot see it. GitHub returns ' +
        '404 rather than 403 for private resources the token cannot read.';
    } else if (err.status === 401) {
      hint = 'The GitHub token is invalid or has expired.';
    }
    throw new GitHubApiError(`${action} failed`, err.status, hint);
  }
  throw new GitHubApiError(`${action} failed`, 502);
}

// Bound both a single response and a complete paginated inventory.
const REQUEST_TIMEOUT_MS = 10_000;
const INVENTORY_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function boundedFetch(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, signal, redirect: 'error' });
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('GitHub response exceeds size limit');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

abstract class BaseRegistry implements RunnerRegistry {
  protected constructor(
    private readonly credential: GitHubCredential,
    private readonly apiBaseUrl: string,
  ) {}

  /** A fresh client per call so a rotated or refreshed token takes effect immediately. */
  protected async client(): Promise<Octokit> {
    return new Octokit({
      auth: await this.credential.getToken(),
      baseUrl: this.apiBaseUrl,
      userAgent: 'ci-runner-console',
      request: { fetch: boundedFetch },
    });
  }

  abstract listRunners(): Promise<GitHubRunner[]>;
  abstract createRegistrationToken(): Promise<ScopedToken>;
  abstract createRemoveToken(): Promise<ScopedToken>;
  abstract deleteRunner(runnerId: number): Promise<void>;
  abstract registrationUrl(): string;
  abstract describe(): string;

  protected async listPages(route: string, scope: Record<string, string>): Promise<GitHubRunner[]> {
    const octokit = await this.client();
    const runner = z.object({
      id: z.number().int().positive().safe(), name: z.string().min(1).max(256), os: z.string().max(64),
      status: z.enum(['online', 'offline']), busy: z.boolean(),
      labels: z.array(z.object({ name: z.string().max(256) })).max(100), runner_group_id: z.number().int().positive().safe().optional(),
    });
    const pageSchema = z.object({
      total_count: z.number().int().nonnegative().max(MAX_PAGES * PAGE_SIZE),
      runners: z.array(runner).max(PAGE_SIZE),
    });
    const result: GitHubRunner[] = [];
    const ids = new Set<number>();
    const signal = AbortSignal.timeout(INVENTORY_TIMEOUT_MS);
    let total: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await octokit.request(route, { ...scope, per_page: PAGE_SIZE, page, request: { signal } });
      const data = pageSchema.parse(response.data);
      total ??= data.total_count;
      if (data.total_count !== total || data.runners.length !== Math.min(PAGE_SIZE, total - result.length)) {
        throw new Error('Incomplete or changing runner inventory');
      }
      for (const r of data.runners) {
        if (ids.has(r.id)) throw new Error('Runner pagination repeated an id');
        ids.add(r.id);
        result.push({ ...r, labels: r.labels.map((l) => l.name), runnerGroupId: r.runner_group_id });
      }
      if (result.length === data.total_count) return result;
    }
    throw new Error('Runner inventory exceeds page limit');
  }
}

export class RepoRunnerRegistry extends BaseRegistry {
  constructor(
    credential: GitHubCredential,
    apiBaseUrl: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {
    super(credential, apiBaseUrl);
  }

  async listRunners(): Promise<GitHubRunner[]> {
    try {
      return await this.listPages('GET /repos/{owner}/{repo}/actions/runners', { owner: this.owner, repo: this.repo });
    } catch (err) {
      wrap(err, 'Listing repository runners');
    }
  }

  async createRegistrationToken(): Promise<ScopedToken> {
    try {
      const octokit = await this.client();
      const { data } = await octokit.rest.actions.createRegistrationTokenForRepo({
        owner: this.owner,
        repo: this.repo,
      });
      const parsed = z.object({ token: z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/), expires_at: z.string().datetime({ offset: true }) }).parse(data);
      return { token: parsed.token, expiresAt: parsed.expires_at };
    } catch (err) {
      wrap(err, 'Creating a registration token');
    }
  }

  async createRemoveToken(): Promise<ScopedToken> {
    try {
      const octokit = await this.client();
      const { data } = await octokit.rest.actions.createRemoveTokenForRepo({
        owner: this.owner,
        repo: this.repo,
      });
      const parsed = z.object({ token: z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/), expires_at: z.string().datetime({ offset: true }) }).parse(data);
      return { token: parsed.token, expiresAt: parsed.expires_at };
    } catch (err) {
      wrap(err, 'Creating a removal token');
    }
  }

  async deleteRunner(runnerId: number): Promise<void> {
    try {
      const octokit = await this.client();
      await octokit.rest.actions.deleteSelfHostedRunnerFromRepo({
        owner: this.owner,
        repo: this.repo,
        runner_id: runnerId,
      });
    } catch (err) {
      wrap(err, 'Deleting the runner registration');
    }
  }

  registrationUrl(): string {
    return `https://github.com/${this.owner}/${this.repo}`;
  }

  describe(): string {
    return `repository ${this.owner}/${this.repo}`;
  }
}

export class OrgRunnerRegistry extends BaseRegistry {
  constructor(
    credential: GitHubCredential,
    apiBaseUrl: string,
    private readonly org: string,
  ) {
    super(credential, apiBaseUrl);
  }

  async listRunners(): Promise<GitHubRunner[]> {
    try {
      return await this.listPages('GET /orgs/{org}/actions/runners', { org: this.org });
    } catch (err) {
      wrap(err, 'Listing organization runners');
    }
  }

  async createRegistrationToken(): Promise<ScopedToken> {
    try {
      const octokit = await this.client();
      const { data } = await octokit.rest.actions.createRegistrationTokenForOrg({
        org: this.org,
      });
      const parsed = z.object({ token: z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/), expires_at: z.string().datetime({ offset: true }) }).parse(data);
      return { token: parsed.token, expiresAt: parsed.expires_at };
    } catch (err) {
      wrap(err, 'Creating a registration token');
    }
  }

  async createRemoveToken(): Promise<ScopedToken> {
    try {
      const octokit = await this.client();
      const { data } = await octokit.rest.actions.createRemoveTokenForOrg({
        org: this.org,
      });
      const parsed = z.object({ token: z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/), expires_at: z.string().datetime({ offset: true }) }).parse(data);
      return { token: parsed.token, expiresAt: parsed.expires_at };
    } catch (err) {
      wrap(err, 'Creating a removal token');
    }
  }

  async deleteRunner(runnerId: number): Promise<void> {
    try {
      const octokit = await this.client();
      await octokit.rest.actions.deleteSelfHostedRunnerFromOrg({
        org: this.org,
        runner_id: runnerId,
      });
    } catch (err) {
      wrap(err, 'Deleting the runner registration');
    }
  }

  registrationUrl(): string {
    return `https://github.com/${this.org}`;
  }

  describe(): string {
    return `organization ${this.org}`;
  }
}

export function createRegistry(config: Config, credential: GitHubCredential): RunnerRegistry {
  const { scope, owner, repo, apiBaseUrl } = config.github;
  if (scope === 'org') {
    return new OrgRunnerRegistry(credential, apiBaseUrl, owner);
  }
  return new RepoRunnerRegistry(credential, apiBaseUrl, owner, repo!);
}

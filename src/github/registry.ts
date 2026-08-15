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
    throw new GitHubApiError(`${action} failed: ${err.message}`, err.status, hint);
  }
  throw err;
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
    });
  }

  abstract listRunners(): Promise<GitHubRunner[]>;
  abstract createRegistrationToken(): Promise<ScopedToken>;
  abstract createRemoveToken(): Promise<ScopedToken>;
  abstract deleteRunner(runnerId: number): Promise<void>;
  abstract registrationUrl(): string;
  abstract describe(): string;

  protected static normalise(raw: {
    id: number;
    name: string;
    os: string;
    status: string;
    busy?: boolean;
    labels: { name: string }[];
    runner_group_id?: number;
  }): GitHubRunner {
    return {
      id: raw.id,
      name: raw.name,
      os: raw.os,
      status: raw.status === 'online' ? 'online' : 'offline',
      busy: Boolean(raw.busy),
      labels: raw.labels.map((l) => l.name),
      runnerGroupId: raw.runner_group_id,
    };
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
      const octokit = await this.client();
      const runners = await octokit.paginate(
        octokit.rest.actions.listSelfHostedRunnersForRepo,
        { owner: this.owner, repo: this.repo, per_page: 100 },
      );
      return runners.map((r) => BaseRegistry.normalise(r));
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
      return { token: data.token, expiresAt: data.expires_at };
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
      return { token: data.token, expiresAt: data.expires_at };
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
      const octokit = await this.client();
      const runners = await octokit.paginate(
        octokit.rest.actions.listSelfHostedRunnersForOrg,
        { org: this.org, per_page: 100 },
      );
      return runners.map((r) => BaseRegistry.normalise(r));
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
      return { token: data.token, expiresAt: data.expires_at };
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
      return { token: data.token, expiresAt: data.expires_at };
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

/**
 * The credential layer is deliberately an interface with a single method.
 *
 * v1 ships a fine-grained PAT, but a GitHub App issues installation tokens that
 * expire hourly and must be refreshed. Keeping token acquisition behind an async
 * call means swapping to an App is a new class here rather than a change to every
 * call site.
 */
export interface GitHubCredential {
  /** Resolves a bearer token valid at the moment of the call. */
  getToken(): Promise<string>;
  /** Human-readable description for the UI and audit log. Must never include the token. */
  describe(): string;
}

export class PersonalAccessTokenCredential implements GitHubCredential {
  readonly #token: string;

  constructor(token: string) {
    if (!token) throw new Error('GitHub token is empty');
    this.#token = token;
  }

  async getToken(): Promise<string> {
    return this.#token;
  }

  describe(): string {
    // Classic PATs are prefixed `ghp_`, fine-grained `github_pat_`, OAuth `gho_`.
    // Reporting which kind is in use is useful; reporting any part of the value is not.
    if (this.#token.startsWith('github_pat_')) return 'fine-grained personal access token';
    if (this.#token.startsWith('ghp_')) return 'classic personal access token';
    if (this.#token.startsWith('gho_')) return 'OAuth token';
    return 'personal access token';
  }
}

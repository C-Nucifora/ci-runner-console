import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Identity } from './session.js';

interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
}

export class OidcError extends Error {}

/**
 * A direct implementation of authorization-code + PKCE against Authentik.
 *
 * The ID token is verified against the provider's published JWKS and its issuer,
 * audience and nonce are all checked. The application never trusts a proxy-supplied
 * identity header — see `requireIdentity` in the routes — because the app is
 * reachable on the LAN as well as through the tunnel, and a header-trusting app on
 * a reachable port is an open door.
 */
export class OidcClient {
  #metadata: ProviderMetadata | null = null;
  #jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly cfg: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      allowedGroups: string[];
    },
    private readonly redirectUri: string,
  ) {}

  async metadata(): Promise<ProviderMetadata> {
    if (this.#metadata) return this.#metadata;

    const base = this.cfg.issuer.replace(/\/+$/, '');
    const url = `${base}/.well-known/openid-configuration`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new OidcError(`OIDC discovery failed at ${url}: HTTP ${res.status}`);
    }
    const meta = (await res.json()) as ProviderMetadata;
    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (!meta[field]) throw new OidcError(`OIDC discovery document is missing ${field}`);
    }
    this.#metadata = meta;
    this.#jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    return meta;
  }

  /** Builds the authorization URL and the PKCE material the callback will need. */
  async beginLogin(): Promise<{
    url: string;
    verifier: string;
    nonce: string;
    state: string;
  }> {
    const meta = await this.metadata();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const nonce = randomBytes(24).toString('base64url');
    // The caller substitutes the real state once it has stored the verifier.
    const state = '__STATE__';

    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('state', state);

    return { url: url.toString(), verifier, nonce, state };
  }

  async completeLogin(code: string, verifier: string, nonce: string): Promise<Identity> {
    const meta = await this.metadata();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.cfg.clientId,
      code_verifier: verifier,
    });

    const res = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`,
        ).toString('base64')}`,
      },
      body,
    });

    if (!res.ok) {
      // The response body can echo the code; report the status only.
      throw new OidcError(`Token exchange failed: HTTP ${res.status}`);
    }

    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new OidcError('Token response contained no id_token');

    if (!this.#jwks) throw new OidcError('JWKS not initialised');
    const { payload } = await jwtVerify(tokens.id_token, this.#jwks, {
      issuer: meta.issuer,
      audience: this.cfg.clientId,
    });

    if (payload.nonce !== nonce) {
      throw new OidcError('ID token nonce did not match the login request');
    }

    const identity = toIdentity(payload);

    if (this.cfg.allowedGroups.length > 0) {
      const permitted = identity.groups.some((g) => this.cfg.allowedGroups.includes(g));
      if (!permitted) {
        throw new OidcError(
          `${identity.username} is not a member of any group permitted to use this console`,
        );
      }
    }

    return identity;
  }

  async endSessionUrl(postLogoutRedirect: string): Promise<string | null> {
    const meta = await this.metadata();
    if (!meta.end_session_endpoint) return null;
    const url = new URL(meta.end_session_endpoint);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
    url.searchParams.set('client_id', this.cfg.clientId);
    return url.toString();
  }
}

function toIdentity(payload: JWTPayload): Identity {
  const groupsClaim = payload.groups;
  const groups = Array.isArray(groupsClaim)
    ? groupsClaim.filter((g): g is string => typeof g === 'string')
    : [];

  const username =
    typeof payload.preferred_username === 'string'
      ? payload.preferred_username
      : typeof payload.email === 'string'
        ? payload.email
        : String(payload.sub ?? 'unknown');

  return {
    sub: String(payload.sub ?? ''),
    username,
    email: typeof payload.email === 'string' ? payload.email : null,
    name: typeof payload.name === 'string' ? payload.name : null,
    groups,
  };
}

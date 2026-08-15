import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

export interface Identity {
  sub: string;
  username: string;
  email: string | null;
  name: string | null;
  groups: string[];
}

interface SessionRecord {
  identity: Identity;
  expiresAt: number;
}

/**
 * Sessions are held in memory only.
 *
 * That means a restart signs everyone out, which for an internal console with a
 * handful of operators is a fair trade for never persisting a credential-equivalent
 * to disk. The cookie carries an opaque id plus an HMAC, so a forged or tampered
 * cookie is rejected before any lookup happens.
 */
export class SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #secret: Buffer;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.#secret = Buffer.from(secret, 'utf8');
  }

  create(identity: Identity): string {
    this.#sweep();
    const id = randomBytes(32).toString('base64url');
    this.#sessions.set(id, {
      identity,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
    return `${id}.${this.#sign(id)}`;
  }

  get(cookie: string | undefined): Identity | null {
    if (!cookie) return null;
    const sep = cookie.lastIndexOf('.');
    if (sep <= 0) return null;

    const id = cookie.slice(0, sep);
    const mac = cookie.slice(sep + 1);
    if (!this.#verify(id, mac)) return null;

    const record = this.#sessions.get(id);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.#sessions.delete(id);
      return null;
    }
    return record.identity;
  }

  destroy(cookie: string | undefined): void {
    if (!cookie) return;
    const sep = cookie.lastIndexOf('.');
    if (sep <= 0) return;
    this.#sessions.delete(cookie.slice(0, sep));
  }

  #sign(id: string): string {
    return createHmac('sha256', this.#secret).update(id).digest('base64url');
  }

  #verify(id: string, mac: string): boolean {
    const expected = Buffer.from(this.#sign(id), 'utf8');
    const given = Buffer.from(mac, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, record] of this.#sessions) {
      if (record.expiresAt <= now) this.#sessions.delete(id);
    }
  }
}

/**
 * Short-lived state for an in-flight OIDC login: the PKCE verifier, the CSRF state
 * value, the nonce, and where to send the user afterwards.
 */
export class LoginStateStore {
  readonly #pending = new Map<
    string,
    { verifier: string; nonce: string; returnTo: string; expiresAt: number }
  >();

  create(data: { verifier: string; nonce: string; returnTo: string }): string {
    this.#sweep();
    const state = randomBytes(32).toString('base64url');
    this.#pending.set(state, { ...data, expiresAt: Date.now() + 10 * 60 * 1000 });
    return state;
  }

  /** Single-use: consuming a state value removes it, so a replayed callback fails. */
  consume(state: string | undefined) {
    if (!state) return null;
    const entry = this.#pending.get(state);
    if (!entry) return null;
    this.#pending.delete(state);
    if (entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.#pending) {
      if (v.expiresAt <= now) this.#pending.delete(k);
    }
  }
}

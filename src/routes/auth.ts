import type { FastifyInstance } from 'fastify';
import type { OidcClient } from '../auth/oidc.js';
import type { LoginStateStore, SessionStore } from '../auth/session.js';
import type { Config } from '../config.js';

export const SESSION_COOKIE = 'crc_session';

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    oidc: OidcClient;
    sessions: SessionStore;
    loginStates: LoginStateStore;
  },
) {
  const { config, oidc, sessions, loginStates } = deps;
  const secureCookie = config.publicBaseUrl.startsWith('https://');

  app.get('/auth/login', async (req, reply) => {
    const query = req.query as { returnTo?: string };
    // Only ever redirect to a path on this origin. An absolute URL here would make
    // the login endpoint an open redirect.
    const returnTo =
      typeof query.returnTo === 'string' && /^\/[^/\\]/.test(query.returnTo)
        ? query.returnTo
        : '/';

    try {
      const begun = await oidc.beginLogin();
      const state = loginStates.create({
        verifier: begun.verifier,
        nonce: begun.nonce,
        returnTo,
      });
      const url = new URL(begun.url);
      url.searchParams.set('state', state);
      return reply.redirect(url.toString());
    } catch (err) {
      req.log.error({ err }, 'failed to start OIDC login');
      return reply.code(502).type('text/html').send(loginErrorPage(err));
    }
  });

  app.get('/auth/callback', async (req, reply) => {
    const query = req.query as { code?: string; state?: string; error?: string; error_description?: string };

    if (query.error) {
      return reply
        .code(400)
        .type('text/html')
        .send(loginErrorPage(new Error(query.error_description || query.error)));
    }

    const pending = loginStates.consume(query.state);
    if (!pending) {
      // Covers a replayed callback, an expired login, and a CSRF attempt alike.
      return reply
        .code(400)
        .type('text/html')
        .send(loginErrorPage(new Error('This login link has expired or was already used.')));
    }
    if (!query.code) {
      return reply.code(400).type('text/html').send(loginErrorPage(new Error('No authorization code returned.')));
    }

    try {
      const identity = await oidc.completeLogin(query.code, pending.verifier, pending.nonce);
      const cookie = sessions.create(identity);
      req.log.info({ user: identity.username, groups: identity.groups }, 'sign-in');
      return reply
        .setCookie(SESSION_COOKIE, cookie, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: secureCookie,
          maxAge: config.sessionTtlSeconds,
        })
        .redirect(pending.returnTo);
    } catch (err) {
      req.log.warn({ err }, 'OIDC login rejected');
      return reply.code(403).type('text/html').send(loginErrorPage(err));
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const cookie = req.cookies[SESSION_COOKIE];
    sessions.destroy(cookie);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    const end = await oidc.endSessionUrl(config.publicBaseUrl).catch(() => null);
    return reply.send({ ok: true, endSessionUrl: end });
  });
}

function loginErrorPage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const escaped = message.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a}
h1{font-size:1.4rem}code{background:#f4f4f5;padding:.15rem .4rem;border-radius:4px}
a{color:#2563eb}</style></head><body>
<h1>Sign-in failed</h1><p>${escaped}</p><p><a href="/auth/login">Try again</a></p></body></html>`;
}

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { AuditLog } from './audit.js';
import { OidcClient } from './auth/oidc.js';
import { LoginStateStore, SessionStore } from './auth/session.js';
import { loadConfig } from './config.js';
import { PersonalAccessTokenCredential } from './github/credentials.js';
import { createRegistry } from './github/registry.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthRoutes, SESSION_COOKIE } from './routes/auth.js';
import { RunnerVmControl } from './vm/ctl.js';
import { RunnerVm } from './vm/ssh.js';

/**
 * Headers a reverse proxy might use to assert an identity. This application
 * authenticates users itself over OIDC and must never read these, but it also
 * listens on a LAN port that is reachable without passing through the proxy — so
 * anyone on the LAN could otherwise set them. They are stripped on the way in,
 * before any handler can see them.
 */
const IDENTITY_HEADERS = [
  'x-forwarded-user',
  'x-forwarded-email',
  'x-forwarded-preferred-username',
  'x-forwarded-groups',
  'x-authentik-username',
  'x-authentik-email',
  'x-authentik-name',
  'x-authentik-uid',
  'x-authentik-groups',
  'x-authentik-entitlements',
  'x-remote-user',
  'remote-user',
  'x-auth-request-user',
  'x-auth-request-email',
  'x-auth-request-groups',
];

async function main() {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Belt and braces: even if a token reached the logger, it would not be printed.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'token',
          '*.token',
          'registrationToken',
          '*.registrationToken',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });

  await app.register(cookie);

  app.addHook('onRequest', async (req) => {
    let stripped: string[] = [];
    for (const header of IDENTITY_HEADERS) {
      if (header in req.headers) {
        delete req.headers[header];
        stripped.push(header);
      }
    }
    if (stripped.length > 0) {
      // Nothing legitimate sets these against this app. Seeing one means either a
      // misconfigured proxy or someone probing for header-trust.
      req.log.warn(
        { headers: stripped, ip: req.ip },
        'stripped proxy identity headers; this app authenticates via OIDC and never trusts them',
      );
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return payload;
  });

  const sessions = new SessionStore(config.sessionSecret, config.sessionTtlSeconds);
  const loginStates = new LoginStateStore();
  const oidc = new OidcClient(config.oidc, `${config.publicBaseUrl}/auth/callback`);
  const credential = new PersonalAccessTokenCredential(config.github.token);
  const registry = createRegistry(config, credential);
  const control = new RunnerVmControl(new RunnerVm(config.vm));
  const audit = new AuditLog(config.auditLogPath);

  // Unauthenticated on purpose, and deliberately free of anything sensitive: this is
  // what the Cloudflare tunnel and any uptime check will hit.
  app.get('/healthz', async () => ({ status: 'ok', service: 'ci-runner-console' }));

  registerAuthRoutes(app, { config, oidc, sessions, loginStates });
  registerApiRoutes(app, { config, sessions, registry, credential, control, audit });

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  // @fastify/static strips `prefix` before resolving against `root`, so the root
  // must be the assets directory itself — pointing it at webRoot would look for
  // `webRoot/index-<hash>.js` and quietly fall through to the SPA handler.
  await app.register(fastifyStatic, {
    root: join(webRoot, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
    immutable: true,
    maxAge: '1y',
  });
  const indexHtml = await readFile(join(webRoot, 'index.html'), 'utf8');

  // Everything else is the single-page app, and the app itself is behind sign-in.
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // A missing asset must 404, never fall through to the SPA. Assets are served
    // with a one-year immutable cache, so answering one with HTML would let a CDN
    // pin that HTML against a script URL for a year and break the app for everyone.
    if (req.url.startsWith('/assets/')) {
      return reply.code(404).type('text/plain').header('cache-control', 'no-store').send('Not found');
    }
    if (!sessions.get(req.cookies[SESSION_COOKIE])) {
      const returnTo = req.url.startsWith('/') ? req.url : '/';
      return reply
        .header('cache-control', 'no-store')
        .redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    // The shell references hashed asset URLs, so it must never be cached itself.
    return reply.type('text/html').header('cache-control', 'no-store').send(indexHtml);
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      target: registry.describe(),
      credential: credential.describe(),
      runnerVm: `${config.vm.user}@${config.vm.host}:${config.vm.port}`,
      cap: config.runners.cap,
      publicBaseUrl: config.publicBaseUrl,
    },
    'ci-runner-console ready',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

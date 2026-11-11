// Frontend only. No backend, proxy, environment files, SSH or identity provider.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = await mkdtemp(resolve(tmpdir(), 'runner-browser-'));
const server = await createServer({
  configFile: false, root: resolve(root, 'web'), cacheDir,
  plugins: [react(), {
    name: 'synthetic-browser-fixture',
    transformIndexHtml: () => [{ tag: 'script', attrs: { src: '/__fixture.js' }, injectTo: 'head-prepend' }],
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/__signed-out') {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><title>Signed out</title><p>Synthetic sign-out completed</p>');
          return;
        }
        const file = { '/__fixture.js': 'browser-fixtures.js', '/__regression.js': 'browser-regression.js' }[req.url];
        if (file) {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(await readFile(resolve(root, 'test', file), 'utf8'));
        } else if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
          res.statusCode = 500;
          res.end('Fixture must intercept every application request');
        } else next();
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
});
await server.listen();
console.log(`Synthetic browser fixture: http://127.0.0.1:${server.httpServer.address().port}`);
async function stop() {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

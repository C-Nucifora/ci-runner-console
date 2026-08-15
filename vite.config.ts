import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Asset filenames carry a per-build id as well as a content hash.
 *
 * Content hashing alone keys the CDN cache on content, which is normally what you
 * want — but it also means a single bad response cached at the edge against an
 * asset URL is pinned there for the lifetime of that content, and assets are
 * served `immutable, max-age=1y`. A build id guarantees every deploy publishes
 * fresh URLs, so a poisoned entry can never survive a release.
 */
const buildId = process.env.BUILD_ID ?? Date.now().toString(36);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${buildId}-[hash].js`,
        chunkFileNames: `assets/[name]-${buildId}-[hash].js`,
        assetFileNames: `assets/[name]-${buildId}-[hash][extname]`,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/auth': 'http://127.0.0.1:8080',
    },
  },
});

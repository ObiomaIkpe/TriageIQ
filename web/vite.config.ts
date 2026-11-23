import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Where the gateway is. In development the UI calls only /api/..., and this dev server forwards it to the
 * gateway with the /api prefix removed (/api/auth/me -> http://localhost:3000/auth/me). The browser therefore
 * only ever talks to ONE origin (http://localhost:5173), so the session cookie is same-origin
 * (SameSite=Strict works, nothing needs CORS) and the gateway's Origin check sees the browser's own Origin.
 * Production (M6) does the same rewrite in the reverse proxy (Caddy).
 */
const GATEWAY = process.env.TIQ_GATEWAY_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true, // the gateway's ALLOWED_ORIGINS names this exact origin
    proxy: {
      '/api': {
        target: GATEWAY,
        // Not rewriting the Host/Origin: the Origin header the browser sent must reach the gateway unchanged.
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api(?=\/|$)/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:5173/' } },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 15_000, // a whole-app test on a slow runner
  },
});

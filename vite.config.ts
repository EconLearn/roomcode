import { defineConfig } from 'vite';

// The dev API (server/dev-api.mjs) runs on 8787; Vercel serves /api in production.
export default defineConfig({
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:8787' } },
  build: { target: 'es2020', rollupOptions: { input: { main: 'index.html', guide: 'guide.html' } } },
});

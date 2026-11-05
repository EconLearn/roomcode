// Local stand-in for the Azure functions: serves api/src/lib.js on http://localhost:8787
// and reads ../.env. Vite (npm run dev) proxies /api here.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const { routes, run } = await import('../api/src/lib.js');

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    const fn = routes[req.url.split('?')[0].replace(/^\/api\//, '')];
    let status = 404, body = { error: 'Not found.' };
    if (fn && req.method !== 'POST') { status = 405; body = { error: 'POST only.' }; }
    else if (fn) {
      let parsed = {};
      try { parsed = JSON.parse(raw || '{}'); } catch { /* treat as empty */ }
      ({ status, body } = await run(fn, parsed));
    }
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  });
}).listen(8787, () => console.log('dev API on http://localhost:8787', process.env.NEXCONN_APP_SECRET ? '(keys loaded)' : '(no keys: front end will use the mock)'));

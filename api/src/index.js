// Azure Static Web Apps managed functions: POST /api/session, /api/rooms, /api/join.
// NEXCONN_APP_KEY / NEXCONN_APP_SECRET / NEXCONN_API_HOST come from the app's settings in Azure.
import { app } from '@azure/functions';
import { routes, run } from './lib.js';

for (const [name, fn] of Object.entries(routes)) {
  app.http(name, {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: name,
    handler: async (req) => {
      const body = await req.json().catch(() => ({}));
      const { status, body: out } = await run(fn, body);
      return { status, jsonBody: out };
    },
  });
}

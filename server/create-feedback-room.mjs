// One-off: creates the permanent public feedback room FEEDB (group channel rcFEEDB).
// Its owner is a team ID that never connects, so it adds no MAU. Run: node server/create-feedback-room.mjs
import { readFileSync, existsSync } from 'node:fs';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const { nexconn } = await import('../api/src/lib.js');
const j = await nexconn('/v4/group-channel/create', {
  channelId: 'rcFEEDB', name: 'Roomcode feedback: ideas and problems', owner: 'uroomcodeteam01',
  permissions: { joinPerm: 1, memInvitePerm: 2 },
});
console.log('create rcFEEDB:', j.code === 0 ? 'OK' : `code ${j.code} ${j.msg ?? ''}`);

// One-off: loads src/blocked-words.json into Nexconn's profanity filter, so chat
// text is cleaned on the server before delivery. Run: node server/set-word-filter.mjs
import { readFileSync, existsSync } from 'node:fs';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const { nexconn } = await import('../api/src/lib.js');
const words = JSON.parse(readFileSync(new URL('../src/blocked-words.json', import.meta.url), 'utf8'));
const j = await nexconn('/v4/profanity-word/batch/add', { words: words.map(word => ({ word, replacement: '***' })) });
console.log('profanity words:', j.code === 0 ? `OK, remaining quota ${j.result?.remainingQuota}` : `code ${j.code} ${j.msg ?? ''}`);

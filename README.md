# Roomcode

A live chat room for any real room. The host starts a room and shows the QR. Everyone joins from their phone with no app and no account. They chat, ask questions the room votes to the top, and answer quick polls. A projector view shows the QR, the top questions and live poll results.

Built on the [Nexconn Chat SDK](https://docs.nexconn.ai/) (`@nexconn/chat` 26.2.1) for the Nexconn Build Challenge 2026.

## Nexconn features used, and where
| Feature | Where |
|---|---|
| `NCEngine.initialize` / `connect` with per-guest tokens | `src/backend/nexconn.ts`, `api/session.mjs` |
| Group channels: one per room, created and joined via the Platform Chat API | `api/rooms.mjs`, `api/join.mjs` |
| Text messages with sender info (nickname) | chat in `src/backend/nexconn.ts` |
| Custom persisted messages: questions, votes, answered marks, polls, poll votes, pins, room close | `RMC:*` types in `src/backend/nexconn.ts` |
| Transient status messages for "is typing…" | `RMC:Typing` |
| Message history (`createMessagesQuery`): late joiners rebuild the room | `history()` |
| Connection status handler: live/connecting/offline dot | header |

Room state is a pure fold over the message history (`src/state.ts`). So votes, polls and host actions survive reloads and late joins with no database of our own. Host-only actions sent by anyone else are ignored.

## Run locally
```bash
npm install
npm run dev          # http://localhost:5173: offline mock, no keys needed
```
In mock mode, rooms are shared between tabs of the same browser. Add `?tab` to a URL to make that tab a different guest, e.g. `http://localhost:5173/?tab#/r/ABCDE`.

With real Nexconn keys (added by `ADD_NEXCONN_KEYS.command`): run `npm run api` in one terminal and `npm run dev` in another.

```bash
npm test             # room-state unit tests
npm run typecheck
```

## Deploy (Azure Static Web Apps, Free tier, $0)
- Live at https://lemon-smoke-0d1aa451e.6.azurestaticapps.net (resource group `roomcode-rg`, app `roomcode`).
- The site is `dist/`. `api/` (Azure Functions, Node 20) serves `/api/session`, `/api/rooms` and `/api/join`.
- Keys: double-click `ADD_NEXCONN_KEYS.command`. It writes `.env` and the Azure app settings; the App Secret never leaves those two places.
- Redeploy: `npm run build`, then `swa deploy ./dist --api-location ./api --api-language node --api-version 20 --app-name roomcode --resource-group roomcode-rg --env production`.
- pages.dev is blocked by the school web filter; azurestaticapps.net is not intercepted (MEASURED 5 Nov).

## Privacy
- Nickname only: no email, no phone, no location, no tracking scripts.
- One random guest ID per device, kept in localStorage.
- Rooms close after 24 hours.

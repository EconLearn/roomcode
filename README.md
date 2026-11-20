# Roomcode

Room Q&A that shows when minds change and when people are lost. The host starts a room and shows the QR. Everyone joins from their phone with no app, no account and no name prompt, and is two taps from asking a question.

- **Questions ranked by votes**, with "Hide my name", a duplicate check ("Already asked? Vote for it instead") and a host queue: Answer now, Done/next, Poll it.
- **Second take**: the host re-opens a poll after discussion; every screen shows the first-round share next to the new one and how many people changed their mind.
- **I'm lost**: one private tap. The host sees a count, never a name.
- **Projector view**: the question being answered in large type, what's next, the live poll, the join QR; a closing slide when the room ends.
- **Recap on every device** when the room ends (similar questions grouped; copy or download as Markdown).
- **Host moderation**, a word filter, translation into 15 languages, voice-to-text questions, a larger-text switch, a reconnecting banner.

Built on the [Nexconn Chat SDK](https://docs.nexconn.ai/) (`@nexconn/chat` 26.2.1) for the Nexconn Build Challenge 2026.

## Nexconn features used, and where
| Feature | Where |
|---|---|
| `NCEngine.initialize` / `connect` with per-guest tokens | `src/backend/nexconn.ts`, `session` in `api/src/lib.js` |
| Group channels: one per room, created and joined via the Platform Chat API | `rooms`, `join` in `api/src/lib.js` |
| Text messages with sender info (nickname) | chat in `src/backend/nexconn.ts` |
| Custom persisted messages: questions, votes, answered marks, answering-now, polls and their second take, poll votes, the "I'm lost" signal, pins, room close, joins, host hide / remove | twelve `RMC:*` types in `src/backend/nexconn.ts` |
| Group member mute and group freeze (Platform Chat API): a removed guest can't post; an ended room is frozen | `moderate` in `api/src/lib.js` |
| Profanity filter (Platform Chat API word list) | `server/set-word-filter.mjs`, same list masked on screen by `src/filter.ts` |
| Built-in translation (`translateModule.translateMessages`, `TranslateHandler`) | `translate()` in `src/backend/nexconn.ts`; menu → Translate messages |
| Transient status messages: "is typing…", and a room snapshot the host's screen sends to late joiners | `RMC:Typing`, `RMC:Snap` |
| Message history (`createMessagesQuery`): late joiners rebuild the room | `history()` |
| Connection status handler: live dot, reconnecting banner, history catch-up after a reconnect | `onStatus` in `src/main.ts` |

Room state is a pure fold over the message history (`src/state.ts`). So votes, polls and host actions survive reloads and late joins with no database of our own. Host-only actions sent by anyone else are ignored.

Identity: each browser keeps a random device secret, and the server derives the chat user ID from it with an HMAC. Reading someone's user ID off a message is not enough to get a token for it, so nobody can act as the host.

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
- The site is `dist/`. `api/` (Azure Functions, Node 20) serves `/api/session`, `/api/rooms`, `/api/join` and `/api/moderate`.
- Keys: double-click `ADD_NEXCONN_KEYS.command`. It writes `.env` and the Azure app settings; the App Secret never leaves those two places.
- Redeploy: `npm run build`, then `swa deploy ./dist --api-location ./api --api-language node --api-version 20 --app-name roomcode --resource-group roomcode-rg --env production`.
- pages.dev is blocked by the school web filter; azurestaticapps.net is not intercepted (MEASURED 5 Nov).

## Demo mode and test users
- Add `?mock` to the live URL to try everything offline in one browser (`?mock&tab` makes a tab its own guest). Nothing is sent to Nexconn in this mode.
- Development test users on the judged App Key are listed in `docs/TEST_IDS.md`, so they can be subtracted from the active-user count.

## Privacy
- Nickname only: no email, no phone, no location, no tracking scripts. "I'm lost" reaches the host as a count only.
- One random device secret per browser, kept in localStorage; the chat user ID is derived from it on the server.
- The host can hide posts and remove people; a short offensive-word list is masked.
- Rooms close after 24 hours.

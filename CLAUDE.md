# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
docker compose up --build          # full stack: db (5432), api (3000), web (5173)
```

API (`api/`, no build step):

```sh
npm run dev                        # node --watch src/server.js
npm test                           # node --test -> runs api/test/*.test.js only
node --test test/contract.test.js  # single unit test file
node test/integration.mjs          # end-to-end smoke test; NOT part of `npm test`
```

`api/test/integration.mjs` is a bare assertion script, not a `node:test` suite. It needs a
running API + database and talks to `TEST_API_URL` (default `http://127.0.0.1:3000/api`) and
`TEST_WS_URL` (default `ws://127.0.0.1:3000/ws`). It registers users with a timestamp suffix,
so it is safe to re-run against a live dev database.

Web (`web/`): `npm run dev`, `npm run build`, `npm run preview`. There is no web test suite and
no linter configured anywhere in the repo.

Running the web dev server outside Docker requires overriding the proxy targets, which default
to the compose service hostname `api`:

```sh
VITE_API_PROXY_TARGET=http://127.0.0.1:3000 VITE_WS_PROXY_TARGET=ws://127.0.0.1:3000 npm run dev
```

## Architecture

Two independent npm packages, both ESM, both Node >= 20, sharing no code. The browser talks to
same-origin `/api` and `/ws`; Vite proxies both to the API container. `VITE_API_URL` /
`VITE_WS_URL` override that with absolute origins.

### API (`api/src/`)

`server.js` builds one `http.Server` shared by Express and the WebSocket server, then
`waitForDatabase()` (30 × 1s retry) and `migrate()` before listening.

- `db.js` — the entire schema is one idempotent `CREATE TABLE IF NOT EXISTS` string applied on
  every boot inside a transaction guarded by `pg_advisory_lock(73918421)`, so concurrent API
  instances can't race. There are no migration files; **schema changes mean editing that string
  in a backwards-compatible way** (existing tables are never altered by it).
- `auth.js` — throws at *import* time if `JWT_SECRET` is unset, so the process refuses to boot.
  HS256 only, on both sign and verify.
- `routes.js` — module-level `express.Router()` singleton. `createRouter(presence)` exists only
  to inject the in-memory presence map into `GET /api/presence`; calling it twice would register
  that route twice. It also exports `memberOfRoom` / `dmParticipant`, which `websocket.js`
  imports — authorization logic lives here and is shared with the realtime layer.
- `websocket.js` — `createRealtime(server)` attaches an `upgrade` handler that requires
  `/ws?token=<jwt>`; a bad token gets close code **4401** (the client treats it as "log out"),
  a wrong path gets the socket destroyed.

Realtime rules that are easy to break:

- **Writes are serialized twice**: each socket has an `operationQueue`, and all `message:send`
  work additionally funnels through a single process-wide `messageQueue`, so message IDs and
  broadcast order stay consistent.
- **Room delivery requires membership AND an active `room:subscribe`.** DM delivery requires
  only that the client's user is one of the two participants — DMs are not subscribed to.
- Presence is a process-local `Map` of userId → open connection count. Multi-instance deploys
  would need a shared adapter. `presence:update` is broadcast to *all* clients.
- `typing` is fire-and-forget to room subscribers except the sender; nothing is persisted.

Data model invariants enforced in SQL, not just in code: `messages` has a CHECK that exactly one
of `room_id`/`conversation_id` is set; `dm_conversations` has `CHECK (user_one_id < user_two_id)`
plus a unique pair constraint, so `POST /api/dms` normalizes the pair with min/max and upserts.

Pagination is keyset on `messages.id` (`WHERE id < $before ORDER BY id DESC LIMIT limit+1`),
served through partial indexes per destination type. Responses are reversed to oldest-to-newest;
`nextCursor` is the id of the *first* (oldest) returned message, or null.

### Web (`web/src/App.jsx`)

The whole client is one file: `App`, `Auth`, `Sidebar`, `Chat`, and two modals. All state lives
in `App` — no router, no state library. The session (`{token, user}`) is persisted to
`localStorage` under `chateria-session`.

- One WebSocket for the session, recreated by a `connect()` closure with a 1200ms reconnect
  timer; close code 4401 logs out instead of reconnecting. On reopen it re-sends
  `room:subscribe` for the active room.
- `activeRef` / `peopleRef` mirror state because the long-lived `ws.onmessage` closure would
  otherwise capture stale values. Keep that pattern when adding frame handlers.
- Sent messages are **not** optimistically rendered; they appear when the server echoes
  `message:new`. The reducer de-dupes by message id.
- `Chat` manages scroll manually via three `useLayoutEffect`s keyed on `active.id`, `lastId`,
  and `firstId`: switching conversations jumps to the bottom, new messages only auto-scroll when
  the user was already pinned to the bottom, and prepending older pages restores the previous
  offset by diffing `scrollHeight`.
- Components carry `data-testid` attributes throughout; external E2E tooling depends on them, so
  preserve existing ids when editing markup.

## Conventions

- Route handlers use `try/catch` with `return next(error)`; the error middleware in `server.js`
  maps `entity.too.large` → 413 and JSON `SyntaxError` → 400, everything else → 500.
- IDs come out of Postgres as strings — `format.js` (`messageFromRow`, `parsePositiveId`,
  `pagination`) is the single place that normalizes them to numbers and timestamps to ISO. Use
  it rather than hand-shaping rows.
- `README.md` documents the intended product behavior (case-sensitive usernames, duplicate room
  names allowed, idempotent joins, whitespace trimming, 30s presence bound). Treat it as the
  spec when changing semantics.
- Stray editor backups (`*~`, `.*.un~`) exist on disk under `api/` and `web/`; they are
  gitignored, so don't treat them as source.

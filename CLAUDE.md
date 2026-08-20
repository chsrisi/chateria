# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
docker compose up -d                  # PostgreSQL 18.4 (nothing else runs in Docker)
npm install                           # npm workspaces; installs all three packages
npm run dev                           # both Electron apps together
npm run dev:server                    # server app only
npm run dev:client                    # client app only
npm run typecheck                     # tsc across every workspace
npm test                              # unit tests in both apps, no database needed
npm run test:e2e                      # end-to-end contract, needs the database up
npm run build                         # electron-vite build for both apps
```

Single test file / single test:

```sh
node --test packages/server/test/auth.test.ts
node --test --test-name-pattern "alg confusion" packages/server/test/auth.test.ts
```

Tests are plain `.ts` run through **Node's native type stripping** — there is no
compile step and no test framework beyond `node:test`. Each `test/` directory has
its own `package.json` containing only `{"type":"module"}`: the app packages must
stay CommonJS for electron-vite's `externalizeDepsPlugin`, but the test files are
ESM. The `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` flag in the test scripts
silences the resulting reparse warning; keep it when editing those scripts.

`test:e2e` boots the real Express + WebSocket + Postgres stack in-process via
`createApiRuntime` — no Electron involved. Override the database with
`CHATERIA_DATABASE_URL`, the port with `TEST_API_PORT`, and see server logs with
`TEST_VERBOSE=1`.

## Layout

Three workspaces under `packages/`:

- **`protocol`** — the wire contract. Plain TypeScript with **no build step**:
  `main`/`types` point straight at `src/index.ts`, and it sits in each app's
  `devDependencies` so electron-vite bundles it from source instead of
  externalising it. Both `electron.vite.config.ts` files also alias it explicitly.
  Changing an event shape here breaks compilation on whichever side lags.
- **`server`** — Electron app that *hosts* the backend. `src/main/api/` is the
  entire backend and imports no Electron API, which is why the E2E test can drive
  it headlessly.
- **`client`** — Electron chat app. All server state lives in one zustand store.

## Architecture

### The backend is a library the desktop shell drives

`createApiRuntime(keyDirectory, log)` in `src/main/api/server.ts` returns
`start` / `stop` / `stats` / `rotate`. The Electron main process owns lifecycle,
settings, and the log ring buffer; it never reaches into request handling.

`rotate()` deliberately stops and restarts a running server: the router and hub
captured the previous `SigningKeys` object, so swapping the variable alone would
leave the live server verifying against the retired public key.

### Dependency direction (this is what the v1 rewrite fixed)

`queries.ts` holds every shared DB helper — `memberOfRoom`, `dmParticipant`,
`insertMessage`, `messagePage`, the DM summary SQL. Both `routes.ts` and
`realtime.ts` import it and **neither imports the other**. In the old JavaScript
version the WebSocket module imported authorization helpers back out of the
router, which forced the router to be a module-level singleton. Do not reintroduce
that edge; put anything both layers need into `queries.ts`.

`createRouter({ pool, keys, hub, config })` takes the hub, which is how REST
mutations broadcast.

### Broadcasts are the point

REST handlers emit WebSocket events so clients never refetch after a mutation:
`room:created`, `room:member_joined`, `room:member_left`, `dm:created`,
`user:registered`. Two rules that the E2E test pins down:

- Membership events fire **only on a real change** — guarded by `rowCount` from
  the `ON CONFLICT DO NOTHING` insert and the `DELETE`. A repeat join is silent.
- `dm:created` is rendered **once per recipient**, because each participant's
  `otherUser` is the other person. `INSERT ... RETURNING (xmax = 0) AS created`
  distinguishes a real insert from an upsert of an existing pair.

Delivery asymmetry, easy to break: room messages require membership **and** an
active `room:subscribe`; DM messages require only participation (there is no DM
subscribe step).

### Message ordering

Every `message:send` passes through a per-connection `queue` and then a single
process-wide `writeChain`. Without the second one, concurrent senders could commit
in one order and broadcast in another, so replayed history would not match what
people saw live.

### Auth

ES256 only. `keys.ts` persists an ECDSA P-256 pair as PEM in the app's `userData`
(private key mode `0o600`); `auth.ts` signs with `jose` and verifies with
`algorithms: ['ES256']` plus issuer `chateria-server` and audience
`chateria-client` — that pinning is what rejects `alg: none` and confusion
attacks, so do not loosen it. The public JWK is served at
`/.well-known/jwks.json`.

Passwords use `node:crypto` scrypt encoded as `scrypt$<salt-b64>$<hash-b64>`.
The scheme prefix exists so the format can change later. Avoid native hashing
modules here: they would need an Electron rebuild step.

Untrusted input is parsed, not cast — `frames.ts` holds the zod schemas for every
WebSocket frame and REST body.

### Client state

`src/renderer/src/store.ts` is one zustand store plus `applyServerEvent`, the
single reducer for everything the server pushes. Components subscribe with
selectors; `App.tsx` holds an `activeRef` mirror because the long-lived socket
callbacks would otherwise capture stale state.

`realtime.ts` owns one socket with exponential backoff and **re-sends
`room:subscribe` on every reconnect** — subscriptions are per-connection server
state and do not survive a drop. Close code `4401` signs out instead of retrying.

Sent messages are not rendered optimistically; the sender's own `message:new`
carries back `clientNonce` if reconciliation is ever added.

## Constraints worth knowing

- **electron-vite 5 does not support Vite 8**, and `@vitejs/plugin-react` 6
  requires Vite 8. The working combination is pinned: Vite 7 + plugin-react 5.
  Bumping either alone breaks `npm install`.
- Electron 43 has **no postinstall**; it downloads its binary lazily on first
  `require('electron')`.
- The app packages must **not** get `"type": "module"` — electron-vite builds the
  main and preload bundles as CommonJS with dependencies externalised.
- `main` process code must avoid ESM-only dependencies for the same reason. That
  is why `settings.ts` and `vault.ts` are hand-rolled instead of using
  `electron-store`.
- Postgres 18 images put PGDATA in `/var/lib/postgresql/18/docker` and want the
  volume on `/var/lib/postgresql`. Compose uses `postgres_data_v18`; the old
  `chateria_postgres_data` volume still holds PostgreSQL 16 data and will make
  the 18 container refuse to start if remounted.
- Schema changes go in the `SCHEMA` string in `db.ts`, applied idempotently under
  advisory lock `73918421` on every start. There are no migration files, so
  statements must stay backwards compatible — existing tables are never altered.

## Conventions

- Express 5 forwards async rejections automatically; handlers `throw` and let the
  error middleware in `server.ts` map them (`entity.too.large` → 413, JSON
  `SyntaxError` → 400, everything else → 500). Only catch what you will translate,
  as `/auth/register` does for unique-violation `23505`.
- `format.ts` is the single place pg rows become wire types. `db.ts` installs an
  INT8 parser so BIGINT ids arrive as numbers rather than strings.
- `README.md` documents intended product behaviour; treat it as the spec when
  changing semantics.

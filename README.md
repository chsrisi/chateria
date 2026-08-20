# Chateria

Real-time rooms and direct messages, as **two desktop applications**:

| App | What it is | Package |
| --- | --- | --- |
| **Chateria Server** | Control panel that *hosts* the backend — HTTP API, WebSocket hub, migrations, ES256 key management, live activity log | `packages/server` |
| **Chateria** | The chat client people actually use | `packages/client` |

Both are Electron 43 + React 19 + TypeScript 7, sharing one typed wire contract
(`packages/protocol`). PostgreSQL 18.4 runs in Docker.

## Run it

```sh
docker compose up -d          # PostgreSQL 18.4
npm install
npm run dev                   # launches both desktop apps
```

The server app auto-starts the API on port 3000 and creates its signing key on
first launch. The client app asks which server to connect to (defaults to
`http://127.0.0.1:3000`) and probes it before you sign in.

To run just one: `npm run dev:server` or `npm run dev:client`.

## Tests

```sh
npm test                      # 22 unit tests, no database needed
npm run test:e2e              # 18 end-to-end checks; needs the database up
```

`test:e2e` boots the real Express + WebSocket + Postgres stack in-process (no
Electron) and asserts the full contract: ES256 token handling, key rotation,
pagination, DM isolation, and every state broadcast.

## Packaging

```sh
npm run build                 # compile both apps
npm run dist -w @chateria/server
npm run dist -w @chateria/client
```

## Architecture notes

**Two apps, one contract.** `@chateria/protocol` is plain TypeScript with no
build step, imported by both apps. Change an event shape and whichever side has
not caught up fails to compile.

**ES256, not a shared secret.** The server generates an ECDSA P-256 keypair into
its Electron `userData` directory on first run and signs JWTs with the private
half. Verification pins `algorithms: ['ES256']` plus issuer and audience, so
`alg: none` and algorithm-confusion tokens are rejected before any signature
check. The public half is served at `/.well-known/jwks.json`; the private key
never leaves the machine. Rotating the key from the UI cycles the running server
and invalidates every issued token.

**State changes are broadcast, not polled.** Creating a room, joining, leaving,
opening a DM, and registering all emit WebSocket events from the REST handlers,
so every connected client's sidebar stays correct without refetching:

| Event | Goes to | Carries |
| --- | --- | --- |
| `room:created` | everyone | the room and its creator |
| `room:member_joined` | everyone | new member and updated count |
| `room:member_left` | everyone | departing user and updated count |
| `dm:created` | the two participants | the conversation, rendered per side |
| `user:registered` | everyone | the new account |
| `presence:update` | everyone | online/offline transitions |
| `message:new` | room subscribers, or both DM participants | the stored message |

Membership events fire only on a *real* change, so a repeat join stays silent.

**Message ordering.** Every insert passes through a per-connection queue and
then one process-wide chain, so stored order and broadcast order cannot diverge.

## Behaviour

- Usernames are trimmed, case-sensitive, and unique as stored. Passwords are
  opaque up to 1,024 characters, hashed with scrypt (`node:crypto`, no native
  dependency to rebuild for Electron).
- Room names may repeat. Selecting a room joins it idempotently; creators join
  automatically. Leaving removes membership but keeps the room and its history.
- The room list is public to authenticated users; room history and live
  subscriptions require membership.
- DM conversations are unique unordered pairs; creating an existing one returns
  its id with `201`.
- Empty and whitespace-only messages are rejected; bodies are trimmed and capped
  by the server's `maxMessageLength` (4,000 default), which the client reads
  from `/api/info`.
- Presence is process-local and reflects authenticated sockets. Multiple windows
  count as one online user. A shared adapter would be needed to run more than
  one server instance.
- Cursor pagination walks persisted ids; pages are oldest-to-newest and later
  inserts cannot disturb the walk.
- Room delivery requires membership **and** an active subscription; DM delivery
  requires only participation.

## Security notes

Renderers run with `contextIsolation`, `sandbox`, and no Node integration, and
reach the main process only through a fixed-channel `contextBridge`. Authors and
timestamps are assigned solely by the server — a client claiming another
`authorId` is ignored. Every WebSocket frame is parsed with zod before a handler
sees it. React renders message bodies as text. The client stores its token via
the OS keychain (`safeStorage`); where that is unavailable the session simply
does not persist.

## Database volume

PostgreSQL 18 images store data under `/var/lib/postgresql/18/docker` and expect
the volume at `/var/lib/postgresql`. Compose therefore uses a new volume,
`postgres_data_v18`. The pre-2.0 PostgreSQL 16 volume (`chateria_postgres_data`)
is left in place; remove it with `docker volume rm chateria_postgres_data` when
you no longer want that data.

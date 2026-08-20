# Chateria

A real-time room and direct-message chat application built with Node.js 20, Express, PostgreSQL 16, WebSockets, React 18, and Vite.

## Run it

```sh
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173). The JSON API and WebSocket endpoint are available on port 3000. Database migrations run automatically and safely on every API startup.

No `.env` file is required. Compose uses the documented development defaults from `.env.example`; copy that file to `.env` when you want to override them. Change `JWT_SECRET` before any non-development deployment.

## Development

For a local Node workflow, start PostgreSQL, set the variables documented in `.env.example`, then run `npm install` and `npm run dev` in both `api/` and `web/`.

## Assumptions

- Usernames are trimmed at registration, remain case-sensitive, and are unique exactly as stored. Passwords are opaque strings with a 1,024-character input cap and are stored as bcrypt hashes.
- Room names may be duplicated. Selecting a room joins it idempotently; creators are joined automatically. Leaving removes the current membership but does not delete the room or its history.
- The room list is public to authenticated users, while room history and real-time subscriptions require membership.
- Direct-message conversations are unique unordered pairs. Creating an existing DM returns its existing conversation ID with the specified `201` response.
- Empty/whitespace-only messages are rejected. Leading and trailing whitespace is trimmed and message bodies are capped by `MAX_MESSAGE_LENGTH` (4,000 by default).
- Presence is process-local and reflects authenticated WebSocket connections. A user becomes offline immediately after their final connection closes, satisfying the 30-second contract bound. In a multi-instance API deployment this map would need a shared presence adapter.
- Cursor pagination uses persisted message IDs. Pages are returned oldest-to-newest, and inserts after a page is read cannot alter the older-message walk.
- Typing indicators are ephemeral room events and expire in the UI after 1.8 seconds.
- The browser uses same-origin `/api` and `/ws` paths by default; Vite proxies them to the API container. Optional absolute browser endpoints can be provided with `VITE_API_URL` and `VITE_WS_URL`.

## Security notes

JWT validation is restricted to HS256 and rejects unsigned, invalid, and expired tokens. Authors and timestamps are assigned exclusively by the server. The database enforces exactly one destination per message and exactly two distinct users per DM. React renders message content as text.

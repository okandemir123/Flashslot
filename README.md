# FlashSlot

A ticket reservation backend that never sells the same seat twice, even when hundreds of people click at the same moment.

## The problem

When two users try to book the same seat at the same time, a naive "check if free, then book" flow breaks. Both requests see the seat as free, and both succeed. This is called a **race condition**.

This repo contains the broken version on purpose (`/reserve-unsafe`) so the bug can be reproduced, and the fixed version that solves it.

## How it works

Two layers, each one atomic:

1. **Redis (fast gatekeeper):** `SET hold:<seat> <user> NX EX 120`. `NX` = "only set if it does not exist", so exactly one user can hold a seat; everyone else is rejected instantly, without touching the database. `EX 120` expires abandoned holds automatically.
2. **PostgreSQL (final decision):** the holder confirms with `SELECT ... FOR UPDATE` inside a transaction, which locks the seat row until COMMIT. Even if the first layer misbehaves, the database can never book the same seat twice.

```
            hold (Redis, atomic)              reserve (PostgreSQL, row lock)

client A ──► SET hold:A1 NX EX 120 ──► OK ──► BEGIN;
client B ──► SET hold:A1 NX EX 120 ──► nil      SELECT ... FOR UPDATE   ← row locked
             (409, rejected instantly)        status = 'available'? → UPDATE → COMMIT
```

## Tech stack

- Node.js + Express
- PostgreSQL 16 (row-level locking)
- Redis (atomic holds with expiry)

## API

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| GET | `/seats` | List all seats (`available` / `held` with TTL / `reserved`) |
| GET | `/health` | Service health check (PostgreSQL and Redis reported separately) |
| POST | `/hold/:label/:user` | Hold a seat for 120 seconds |
| POST | `/reserve/:label/:user` | Confirm the booking (only for the user holding the seat) |
| POST | `/release/:label/:user` | Give up a hold before it expires (only for the holder) |
| POST | `/reserve-unsafe/:label/:user` | Naive version without locking, to demonstrate the bug |

## Web UI

Open `http://localhost:3000` — a small polling page shows seats in green (available), yellow (held, with TTL countdown) and red (reserved). Click a green seat to hold it, click your yellow seat to reserve it. Open two browsers and fight over a seat.

## Run it locally

Requirements: Node.js 20+, PostgreSQL, Redis.

```bash
npm install

# create the database, user and seats (development only)
sudo su postgres -c "psql -c 'CREATE DATABASE flashslot;'"
sudo su postgres -c "psql -c \"CREATE USER flash WITH PASSWORD 'flash123' SUPERUSER;\""
sudo su postgres -c "psql -d flashslot" < schema.sql

cp .env.example .env   # then edit the values
npm start
```

## Try it: 20 users, one seat

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/hold/A1/user$i &
done | sort | uniq -c
```

Expected result: exactly one `200` and nineteen `409`.

Benchmark version (autocannon):

```bash
npx autocannon -c 20 -a 20 -m POST localhost:3000/hold/A1/bench
```

Measured result (GitHub Codespaces, 20 concurrent connections):

- **1×2xx** (winner) and **19×409** (rejected) — 20 requests in 1.02s
- Average latency 113.9 ms, max 122 ms — every request answered in ~0.1s
- The 19 losers were rejected by Redis atomically, without ever reaching PostgreSQL

## Failure scenario: hold succeeds, reservation fails

The two layers can disagree, and the system stays correct:

- **Hold expired before checkout:** `/reserve` returns `403` — the seat is free for someone else to hold.
- **Seat got reserved between hold and confirm:** the `FOR UPDATE` lock serializes the two transactions; the loser sees `status = 'reserved'`, gets `409`, and its stale hold is deleted. The seat is never double-booked.

## Operations

- **Graceful shutdown:** on `SIGTERM`/`SIGINT` the server stops accepting new requests, lets running ones finish, and closes the Redis and PostgreSQL connections cleanly — no half-open connections on deploy.
- **Health check:** `GET /health` reports PostgreSQL and Redis status separately (`{ "status": "ok", "db": true, "redis": true }`), so a degraded dependency is visible without killing the whole service.

## Lessons learned

- "Check, then act" is never atomic — without a lock, concurrent requests both pass the check.
- `SET ... NX EX` gives you an atomic, self-expiring gate in a single round trip.
- The database must be the final source of truth; Redis is an optimization, not a guarantee.
- Defense in depth: either layer alone can race or fail — together they stay correct.
- Keeping the broken endpoint (`/reserve-unsafe`) makes the fix *demonstrable*, not just claimed.

## Known limitations

- Identity is just a URL parameter — anyone can claim any username. Real systems need authentication.
- The setup script creates a superuser for convenience; production should use a least-privilege role.

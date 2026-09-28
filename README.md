# FlashSlot

A ticket reservation backend that never sells the same seat twice, even when hundreds of people click at the same moment.

## The problem

When two users try to book the same seat at the same time, a naive "check if free, then book" flow breaks. Both requests see the seat as free, and both succeed. This is called a **race condition**.

This repo contains the broken version on purpose (`/reserve-unsafe`) so the bug can be reproduced, and the fixed version that solves it.

## How it works

The fix uses two layers:

1. **Redis (fast gatekeeper):** when a user picks a seat, the server runs `SET hold:<seat> <user> NX EX 120`. `NX` means "only set if it does not exist", so only one user can hold a seat. Everyone else is rejected immediately, without touching the database. `EX 120` makes the hold expire after 120 seconds, so an abandoned checkout frees the seat automatically.
2. **PostgreSQL (final decision):** the user who holds the seat confirms the booking. The server opens a transaction and runs `SELECT ... FOR UPDATE`, which locks the seat row until the transaction ends. Even if something goes wrong in the first layer, the database can never book the same seat twice.

## Tech stack

- Node.js + Express
- PostgreSQL 16 (row-level locking)
- Redis (atomic holds with expiry)

## API

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| GET | `/seats` | List all seats |
| POST | `/hold/:seat/:user` | Hold a seat for 120 seconds |
| POST | `/reserve/:seat/:user` | Confirm the booking (only for the user holding the seat) |
| POST | `/reserve-unsafe/:seat/:user` | Naive version without locking, for demonstrating the bug |

## Run it locally

Requirements: Node.js, PostgreSQL and Redis running on default ports.

```bash
npm install

# create the database, user and seats (development only)
sudo su postgres -c "psql -c 'CREATE DATABASE flashslot;'"
sudo su postgres -c "psql -c \"CREATE USER flash WITH PASSWORD 'flash123' SUPERUSER;\""
sudo su postgres -c "psql -d flashslot" < schema.sql

node server.js
```

## Try it: 20 users, one seat

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/hold/A1/user$i &
done | sort | uniq -c
```

Expected result: exactly one `200` and nineteen `409`.

## Known limitations

- `/hold` does not check if the seat is already permanently reserved. Double booking is still impossible because `/reserve` is protected by the database lock, but the user gets a late error.
- Credentials are hardcoded for learning purposes. In production, use environment variables and a database user with limited permissions.
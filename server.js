require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const HOLD_SECONDS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.use(express.static('public'));

app.get('/health', async (req, res) => {
  const result = { status: 'ok', db: true, redis: true };
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    result.db = false;
  }
  try {
    await redis.ping();
  } catch (err) {
    result.redis = false;
  }
  if (!result.db || !result.redis) result.status = 'degraded';
  res.json(result);
});

app.get('/seats', async (req, res) => {
  const result = await pool.query('SELECT * FROM seats ORDER BY id');
  const seats = result.rows;

  // merge Redis hold state (who holds it + remaining TTL) in one round trip
  const pipeline = redis.pipeline();
  for (const seat of seats) {
    pipeline.get(`hold:${seat.label}`);
    pipeline.ttl(`hold:${seat.label}`);
  }
  const replies = await pipeline.exec();

  const enriched = seats.map((seat, i) => {
    const holder = replies[i * 2][1];
    const ttl = replies[i * 2 + 1][1];
    if (seat.status === 'available' && holder) {
      return { ...seat, status: 'held', held_by: holder, ttl };
    }
    return { ...seat, held_by: null, ttl: null };
  });

  res.json(enriched);
});

// UNSAFE version: no locking, kept on purpose to demonstrate the race condition
app.post('/reserve-unsafe/:label/:user', async (req, res) => {
  const { label, user } = req.params;

  const result = await pool.query('SELECT * FROM seats WHERE label = $1', [label]);
  const seat = result.rows[0];

  if (!seat) return res.status(404).json({ error: 'Seat not found' });
  if (seat.status !== 'available') return res.status(409).json({ error: 'Seat already taken' });

  await sleep(100);

  await pool.query(
    'UPDATE seats SET status = $1, reserved_by = $2 WHERE label = $3',
    ['reserved', user, label]
  );
  res.json({ message: `${user} reserved ${label}` });
});

// STEP 1: temporary hold in Redis (fast gatekeeper)
app.post('/hold/:label/:user', async (req, res) => {
  const { label, user } = req.params;

  // fast-fail if the seat is already permanently reserved in PostgreSQL
  const result = await pool.query('SELECT status FROM seats WHERE label = $1', [label]);
  const seat = result.rows[0];
  if (!seat) return res.status(404).json({ error: 'Seat not found' });
  if (seat.status !== 'available') {
    return res.status(409).json({ error: 'Seat is already reserved' });
  }

  const ok = await redis.set(`hold:${label}`, user, 'EX', HOLD_SECONDS, 'NX');
  if (ok !== 'OK') {
    return res.status(409).json({ error: 'Seat is held by someone else' });
  }
  res.json({ message: `${user} is holding ${label} for ${HOLD_SECONDS} seconds` });
});

// STEP 2: permanent reservation in PostgreSQL, only for the person holding the seat
app.post('/reserve/:label/:user', async (req, res) => {
  const { label, user } = req.params;

  const holder = await redis.get(`hold:${label}`);
  if (holder !== user) {
    return res.status(403).json({ error: 'You do not hold this seat (or your hold expired)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT * FROM seats WHERE label = $1 FOR UPDATE',
      [label]
    );
    const seat = result.rows[0];

    if (!seat) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Seat not found' });
    }
    if (seat.status !== 'available') {
      await client.query('ROLLBACK');
      await redis.del(`hold:${label}`); // clean up the stale hold
      return res.status(409).json({ error: 'Seat already taken' });
    }

    await client.query(
      'UPDATE seats SET status = $1, reserved_by = $2 WHERE label = $3',
      ['reserved', user, label]
    );

    await client.query('COMMIT');
    await redis.del(`hold:${label}`);
    res.json({ message: `${user} reserved ${label}` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Optional: give up a hold before it expires
app.post('/release/:label/:user', async (req, res) => {
  const { label, user } = req.params;

  const holder = await redis.get(`hold:${label}`);
  if (!holder) {
    return res.status(404).json({ error: 'No active hold on this seat' });
  }
  if (holder !== user) {
    return res.status(403).json({ error: 'This seat is held by someone else' });
  }

  await redis.del(`hold:${label}`);
  res.json({ message: `${user} released ${label}` });
});

const server = app.listen(3000, () => console.log('Server running on port 3000'));

async function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully...`);
  server.close();      // stop accepting new requests, let running ones finish
  try {
    await redis.quit();  // close Redis connection cleanly
    await pool.end();    // close all PostgreSQL clients
  } catch (err) {
    console.error('Error during shutdown:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

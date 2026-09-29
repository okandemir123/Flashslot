const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const redis = new Redis(); // connects to localhost:6379 by default

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const HOLD_SECONDS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get('/seats', async (req, res) => {
  const result = await pool.query('SELECT * FROM seats ORDER BY id');
  res.json(result.rows);
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

// STEP 1: temporary hold in Redis (fast, no database involved)
app.post('/hold/:label/:user', async (req, res) => {
  const { label, user } = req.params;

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

app.listen(3000, () => console.log('Server running on port 3000'));
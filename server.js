const express = require('express');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  host: 'localhost',
  user: 'flash',
  password: 'flash123',
  database: 'flashslot',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get('/seats', async (req, res) => {
  const result = await pool.query('SELECT * FROM seats ORDER BY id');
  res.json(result.rows);
});

// HATALI versiyon: kilit yok
app.post('/reserve-unsafe/:label/:user', async (req, res) => {
  const { label, user } = req.params;

  const result = await pool.query('SELECT * FROM seats WHERE label = $1', [label]);
  const seat = result.rows[0];

  if (!seat) return res.status(404).json({ error: 'Koltuk yok' });
  if (seat.status !== 'available') return res.status(409).json({ error: 'Koltuk dolu' });

  await sleep(100);

  await pool.query(
    'UPDATE seats SET status = $1, reserved_by = $2 WHERE label = $3',
    ['reserved', user, label]
  );
  res.json({ message: `${user} ${label} koltuğunu aldı` });
});

// DÜZELTİLMİŞ versiyon: FOR UPDATE kilidi
app.post('/reserve/:label/:user', async (req, res) => {
  const { label, user } = req.params;
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
      return res.status(404).json({ error: 'Koltuk yok' });
    }
    if (seat.status !== 'available') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Koltuk dolu' });
    }

    await sleep(100);

    await client.query(
      'UPDATE seats SET status = $1, reserved_by = $2 WHERE label = $3',
      ['reserved', user, label]
    );

    await client.query('COMMIT');
    res.json({ message: `${user} ${label} koltuğunu aldı` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

app.listen(3000, () => console.log('Sunucu 3000 portunda çalışıyor'));
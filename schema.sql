CREATE TABLE seats (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'available',
  reserved_by TEXT
);

INSERT INTO seats (label)
SELECT 'A' || n FROM generate_series(1, 10) AS n;
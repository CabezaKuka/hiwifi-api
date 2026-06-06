const express = require('express');
const { Pool } = require('pg');
const cors    = require('cors');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  POST /datos
//  Lo llama el ESP-01 en cada ciclo de deep sleep.
//  Body: { token, temperature, humidity }
//  Responde 200 OK o 401 / 400.
// ─────────────────────────────────────────────
app.post('/datos', async (req, res) => {
  const { token, temperature, humidity } = req.body;

  if (!token || temperature == null || humidity == null)
    return res.status(400).json({ error: 'faltan campos' });

  const dev = await pool.query(
    'SELECT id FROM devices WHERE token = $1 AND active = TRUE',
    [token]
  );
  if (dev.rowCount === 0)
    return res.status(401).json({ error: 'token invalido' });

  const device_id = dev.rows[0].id;

  await pool.query(
    'INSERT INTO readings (device_id, temperature, humidity) VALUES ($1, $2, $3)',
    [device_id, temperature, humidity]
  );

  await pool.query(
    'UPDATE devices SET last_seen_at = NOW() WHERE id = $1',
    [device_id]
  );

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  GET /api/:codigo
//  Lo llama el dashboard del cliente.
//  Devuelve info del dispositivo + lecturas según rango.
//  Query param: ?rango=24h | 7d | 30d  (default 24h)
// ─────────────────────────────────────────────
app.get('/api/:codigo', async (req, res) => {
  const { codigo } = req.params;
  const rango = req.query.rango || '24h';

  const intervalMap = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
  const interval = intervalMap[rango] || '24 hours';

  const dev = await pool.query(
    `SELECT d.id, d.device_code, d.location, d.last_seen_at,
            c.name AS client_name, c.retention_days
     FROM   devices d
     LEFT   JOIN clients c ON c.id = d.client_id
     WHERE  d.device_code = $1 AND d.active = TRUE`,
    [codigo]
  );

  if (dev.rowCount === 0)
    return res.status(404).json({ error: 'codigo no encontrado' });

  const device = dev.rows[0];

  const readings = await pool.query(
    `SELECT temperature, humidity, recorded_at
     FROM   readings
     WHERE  device_id = $1
       AND  recorded_at > NOW() - INTERVAL '${interval}'
     ORDER  BY recorded_at ASC`,
    [device.id]
  );

  const rows = readings.rows;
  const temps = rows.map(r => parseFloat(r.temperature));
  const hums  = rows.map(r => parseFloat(r.humidity));

  const last = rows[rows.length - 1] || null;
  const minutesAgo = last
    ? Math.round((Date.now() - new Date(last.recorded_at)) / 60000)
    : null;

  const online = minutesAgo !== null && minutesAgo <= 15;

  res.json({
    device_code:  device.device_code,
    location:     device.location,
    client_name:  device.client_name,
    online,
    minutes_ago:  minutesAgo,
    current: last ? {
      temperature: parseFloat(last.temperature),
      humidity:    parseFloat(last.humidity)
    } : null,
    summary: rows.length ? {
      temp_min: Math.min(...temps).toFixed(1),
      temp_max: Math.max(...temps).toFixed(1),
      hum_avg:  Math.round(hums.reduce((a,b) => a+b, 0) / hums.length)
    } : null,
    readings: rows.map(r => ({
      t:    parseFloat(r.temperature),
      h:    parseFloat(r.humidity),
      ts:   r.recorded_at
    }))
  });
});

// ─────────────────────────────────────────────
//  GET /
//  Sirve el dashboard HTML al cliente.
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.use(express.static(__dirname + '/public'));

// ─────────────────────────────────────────────
//  GET /health  — Railway lo usa para healthcheck
// ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HI-WIFI API corriendo en puerto ${PORT}`));

const express = require('express');
const { Pool } = require('pg');
const cors    = require('cors');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  Middleware admin — verifica header x-admin-key
// ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'no autorizado' });
  next();
}

// ─────────────────────────────────────────────
//  POST /datos
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
//  GET /api/:codigo  — dashboard cliente
// ─────────────────────────────────────────────
app.get('/api/:codigo', async (req, res) => {
  const { codigo } = req.params;
  const rango = req.query.rango || '24h';

  const intervalMap = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
  const interval = intervalMap[rango] || '24 hours';

  const dev = await pool.query(
    `SELECT d.id, d.device_code, d.location, d.last_seen_at
     FROM   devices d
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

  const rows  = readings.rows;
  const temps = rows.map(r => parseFloat(r.temperature));
  const hums  = rows.map(r => parseFloat(r.humidity));

  const last       = rows[rows.length - 1] || null;
  const minutesAgo = last
    ? Math.round((Date.now() - new Date(last.recorded_at)) / 60000)
    : null;
  const online = minutesAgo !== null && minutesAgo <= 15;

  res.json({
    device_code: device.device_code,
    location:    device.location,
    online,
    minutes_ago: minutesAgo,
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
      t:  parseFloat(r.temperature),
      h:  parseFloat(r.humidity),
      ts: r.recorded_at
    }))
  });
});

// ─────────────────────────────────────────────
//  ADMIN: GET /admin/devices
//  Lista todos los dispositivos
// ─────────────────────────────────────────────
app.get('/admin/devices', adminAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, device_code, token, location, active, last_seen_at
     FROM   devices
     ORDER  BY id DESC`
  );
  res.json(result.rows);
});

// ─────────────────────────────────────────────
//  ADMIN: POST /admin/devices
//  Crea un dispositivo nuevo
//  Body: { device_code, token, location }
// ─────────────────────────────────────────────
app.post('/admin/devices', adminAuth, async (req, res) => {
  const { device_code, token, location } = req.body;

  if (!device_code || !token)
    return res.status(400).json({ error: 'device_code y token son obligatorios' });

  // verificar duplicados
  const exists = await pool.query(
    'SELECT id FROM devices WHERE device_code = $1 OR token = $2',
    [device_code, token]
  );
  if (exists.rowCount > 0)
    return res.status(409).json({ error: 'device_code o token ya existe' });

  const result = await pool.query(
    `INSERT INTO devices (device_code, token, location, active)
     VALUES ($1, $2, $3, TRUE)
     RETURNING id, device_code, token, location, active`,
    [device_code, token, location || null]
  );

  res.status(201).json(result.rows[0]);
});

// ─────────────────────────────────────────────
//  ADMIN: PATCH /admin/devices/:id
//  Activa o desactiva un dispositivo
//  Body: { active: true | false }
// ─────────────────────────────────────────────
app.patch('/admin/devices/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;

  if (active == null)
    return res.status(400).json({ error: 'falta campo active' });

  const result = await pool.query(
    'UPDATE devices SET active = $1 WHERE id = $2 RETURNING id, device_code, active',
    [active, id]
  );

  if (result.rowCount === 0)
    return res.status(404).json({ error: 'dispositivo no encontrado' });

  res.json(result.rows[0]);
});

// ─────────────────────────────────────────────
//  GET /  y  /admin  — sirve HTMLs
// ─────────────────────────────────────────────
app.get('/',       (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/admin',  (req, res) => res.sendFile(__dirname + '/public/admin.html'));
app.use(express.static(__dirname + '/public'));

// ─────────────────────────────────────────────
//  GET /health
// ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HI-WIFI API corriendo en puerto ${PORT}`));

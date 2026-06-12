const express = require('express');
const { Pool } = require('pg');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  Middleware admin
// ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'no autorizado' });
  next();
}

app.get('/admin/auth', adminAuth, (req, res) => res.json({ ok: true }));

// ─────────────────────────────────────────────
//  Envío Telegram
// ─────────────────────────────────────────────
function enviarTelegram(botToken, chatId, mensaje) {
  const texto = encodeURIComponent(mensaje);
  const url   = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${texto}`;
  https.get(url, () => {}).on('error', () => {});
}

// ─────────────────────────────────────────────
//  Verificar alertas de valores
// ─────────────────────────────────────────────
async function verificarAlertas(device_code, temperature, humidity) {
  try {
    const result = await pool.query(
      'SELECT * FROM alerts WHERE device_code = $1 AND active = TRUE AND bot_token IS NOT NULL AND chat_id IS NOT NULL',
      [device_code]
    );
    if (result.rowCount === 0) return;

    const alert = result.rows[0];
    const ahora = new Date();
    const unaHora = 60 * 60 * 1000;

    const tempFuera = (alert.temp_min != null && temperature < alert.temp_min) ||
                      (alert.temp_max != null && temperature > alert.temp_max);
    if (tempFuera) {
      const ultimaTemp = alert.last_temp_alert ? new Date(alert.last_temp_alert) : null;
      if (!ultimaTemp || (ahora - ultimaTemp) >= unaHora) {
        const dir = temperature < alert.temp_min ? 'baja' : 'alta';
        const msg = `⚠️ HiWIFI ${device_code}\nTemperatura ${dir}: ${temperature.toFixed(1)}°C\nRango configurado: ${alert.temp_min}° - ${alert.temp_max}°`;
        enviarTelegram(alert.bot_token, alert.chat_id, msg);
        await pool.query('UPDATE alerts SET last_temp_alert = NOW() WHERE device_code = $1', [device_code]);
      }
    }

    const humFuera = (alert.hum_min != null && humidity < alert.hum_min) ||
                     (alert.hum_max != null && humidity > alert.hum_max);
    if (humFuera) {
      const ultimaHum = alert.last_hum_alert ? new Date(alert.last_hum_alert) : null;
      if (!ultimaHum || (ahora - ultimaHum) >= unaHora) {
        const dir = humidity < alert.hum_min ? 'baja' : 'alta';
        const msg = `⚠️ HiWIFI ${device_code}\nHumedad ${dir}: ${humidity.toFixed(0)}%\nRango configurado: ${alert.hum_min}% - ${alert.hum_max}%`;
        enviarTelegram(alert.bot_token, alert.chat_id, msg);
        await pool.query('UPDATE alerts SET last_hum_alert = NOW() WHERE device_code = $1', [device_code]);
      }
    }
  } catch(e) {
    console.error('Error verificando alertas:', e.message);
  }
}

// ─────────────────────────────────────────────
//  Verificar dispositivos offline (cada 5 min)
// ─────────────────────────────────────────────
async function verificarOffline() {
  try {
    // dispositivos activos con alerta configurada y sin señal hace más de 1 hora
    const result = await pool.query(`
      SELECT d.device_code, d.last_seen_at, a.bot_token, a.chat_id, a.last_offline_alert
      FROM   devices d
      JOIN   alerts  a ON a.device_code = d.device_code
      WHERE  d.active = TRUE
        AND  a.active = TRUE
        AND  a.bot_token IS NOT NULL
        AND  a.chat_id   IS NOT NULL
        AND  d.last_seen_at IS NOT NULL
        AND  d.last_seen_at < NOW() - INTERVAL '1 hour'
    `);

    const unaHora = 60 * 60 * 1000;
    const ahora   = new Date();

    for (const row of result.rows) {
      const ultimaAlerta = row.last_offline_alert ? new Date(row.last_offline_alert) : null;
      if (ultimaAlerta && (ahora - ultimaAlerta) < unaHora) continue;

      const d    = new Date(row.last_seen_at);
      const hora = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
      const fecha = d.toLocaleDateString('es-AR');
      const msg  = `📵 HiWIFI ${row.device_code}\nSin señal hace más de 1 hora.\nÚltima lectura: ${fecha} ${hora}`;
      enviarTelegram(row.bot_token, row.chat_id, msg);
      await pool.query(
        'UPDATE alerts SET last_offline_alert = NOW() WHERE device_code = $1',
        [row.device_code]
      );
    }
  } catch(e) {
    console.error('Error verificando offline:', e.message);
  }
}

setInterval(verificarOffline, 5 * 60 * 1000); // cada 5 minutos

// ─────────────────────────────────────────────
//  POST /datos
// ─────────────────────────────────────────────
app.post('/datos', async (req, res) => {
  const { token, temperature, humidity } = req.body;

  if (!token || temperature == null || humidity == null)
    return res.status(400).json({ error: 'faltan campos' });

  const dev = await pool.query(
    'SELECT id, device_code FROM devices WHERE token = $1 AND active = TRUE',
    [token]
  );
  if (dev.rowCount === 0)
    return res.status(401).json({ error: 'token invalido' });

  const { id: device_id, device_code } = dev.rows[0];

  const T  = parseFloat(temperature);
  const H  = parseFloat(humidity);
  const a  = 6.112 * Math.exp(17.67 * T / (T + 243.5));
  const gm = Math.log(H / 100 * a / 6.112);
  const dew_point = parseFloat((243.5 * gm / (17.67 - gm)).toFixed(2));

  await pool.query(
    'INSERT INTO readings (device_id, temperature, humidity, dew_point) VALUES ($1, $2, $3, $4)',
    [device_id, temperature, humidity, dew_point]
  );

  await pool.query(
    'UPDATE devices SET last_seen_at = NOW() WHERE id = $1',
    [device_id]
  );

  verificarAlertas(device_code, T, H);

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  GET /api/:codigo  — dashboard cliente (privado)
// ─────────────────────────────────────────────
async function getDashboardData(codigo, rango) {
  const intervalMap = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
  const interval = intervalMap[rango] || '24 hours';

  const dev = await pool.query(
    `SELECT id, device_code, location, last_seen_at FROM devices WHERE device_code = $1 AND active = TRUE`,
    [codigo]
  );
  if (dev.rowCount === 0) return null;

  const device  = dev.rows[0];
  const readings = await pool.query(
    `SELECT temperature, humidity, dew_point, recorded_at
     FROM   readings
     WHERE  device_id = $1
       AND  recorded_at > NOW() - INTERVAL '${interval}'
     ORDER  BY recorded_at ASC`,
    [device.id]
  );

  const rows  = readings.rows;
  const temps = rows.map(r => parseFloat(r.temperature));
  const hums  = rows.map(r => parseFloat(r.humidity));
  const last  = rows[rows.length - 1] || null;

  const minutesAgo = last
    ? Math.round((Date.now() - new Date(last.recorded_at)) / 60000)
    : null;

  return {
    device_code: device.device_code,
    location:    device.location,
    online:      minutesAgo !== null && minutesAgo <= 15,
    offline:     minutesAgo !== null && minutesAgo > 60,
    minutes_ago: minutesAgo,
    last_seen_at: last ? last.recorded_at : null,
    current: last ? {
      temperature: parseFloat(last.temperature),
      humidity:    parseFloat(last.humidity),
      dew_point:   last.dew_point != null ? parseFloat(last.dew_point) : null
    } : null,
    summary: rows.length ? {
      temp_min: Math.min(...temps).toFixed(1),
      temp_max: Math.max(...temps).toFixed(1),
      hum_avg:  Math.round(hums.reduce((a,b) => a+b, 0) / hums.length)
    } : null,
    readings: rows.map(r => ({
      t:  parseFloat(r.temperature),
      h:  parseFloat(r.humidity),
      d:  r.dew_point != null ? parseFloat(r.dew_point) : null,
      ts: r.recorded_at
    }))
  };
}

app.get('/api/:codigo', async (req, res) => {
  const data = await getDashboardData(req.params.codigo, req.query.rango || '24h');
  if (!data) return res.status(404).json({ error: 'codigo no encontrado' });

  const alertRow = await pool.query(
    'SELECT bot_token, chat_id, temp_min, temp_max, hum_min, hum_max, active FROM alerts WHERE device_code = $1',
    [req.params.codigo]
  );
  data.alert = alertRow.rowCount > 0 ? alertRow.rows[0] : null;

  res.json(data);
});

// ─────────────────────────────────────────────
//  GET /publico/:codigo  — vista pública solo lectura
// ─────────────────────────────────────────────
app.get('/publico/:codigo', async (req, res) => {
  const data = await getDashboardData(req.params.codigo, req.query.rango || '24h');
  if (!data) return res.status(404).json({ error: 'codigo no encontrado' });
  res.json(data);  // sin datos de alertas
});

// ─────────────────────────────────────────────
//  PUT /api/:codigo/ubicacion — editar ubicación desde el dashboard
// ─────────────────────────────────────────────
app.put('/api/:codigo/ubicacion', async (req, res) => {
  const { codigo } = req.params;
  const { location } = req.body;

  const result = await pool.query(
    'UPDATE devices SET location = $1 WHERE device_code = $2 AND active = TRUE RETURNING id',
    [location || null, codigo]
  );
  if (result.rowCount === 0)
    return res.status(404).json({ error: 'dispositivo no encontrado' });

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  POST /api/:codigo/alertas
// ─────────────────────────────────────────────
app.post('/api/:codigo/alertas', async (req, res) => {
  const { codigo } = req.params;
  const { bot_token, chat_id, temp_min, temp_max, hum_min, hum_max, active } = req.body;

  const dev = await pool.query(
    'SELECT id FROM devices WHERE device_code = $1 AND active = TRUE',
    [codigo]
  );
  if (dev.rowCount === 0)
    return res.status(404).json({ error: 'dispositivo no encontrado' });

  await pool.query(
    `INSERT INTO alerts (device_code, bot_token, chat_id, temp_min, temp_max, hum_min, hum_max, active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (device_code) DO UPDATE SET
       bot_token  = EXCLUDED.bot_token,
       chat_id    = EXCLUDED.chat_id,
       temp_min   = EXCLUDED.temp_min,
       temp_max   = EXCLUDED.temp_max,
       hum_min    = EXCLUDED.hum_min,
       hum_max    = EXCLUDED.hum_max,
       active     = EXCLUDED.active,
       updated_at = NOW()`,
    [codigo, bot_token || null, chat_id || null, temp_min || null, temp_max || null,
     hum_min || null, hum_max || null, active !== false]
  );

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  ADMIN routes
// ─────────────────────────────────────────────
app.get('/admin/devices', adminAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, device_code, token, location, active, last_seen_at FROM devices ORDER BY id DESC'
  );
  res.json(result.rows);
});

app.post('/admin/devices', adminAuth, async (req, res) => {
  const { device_code, token, location } = req.body;
  if (!device_code || !token)
    return res.status(400).json({ error: 'device_code y token son obligatorios' });

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
//  Static
// ─────────────────────────────────────────────
app.get('/',         (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/admin',    (req, res) => res.sendFile(__dirname + '/public/admin.html'));
app.get('/p/:codigo',(req, res) => res.sendFile(__dirname + '/public/publico.html'));
app.use(express.static(__dirname + '/public'));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HI-WIFI API corriendo en puerto ${PORT}`));
// SQL para agregar columna last_offline_alert a la tabla alerts:
// ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_offline_alert TIMESTAMPTZ;

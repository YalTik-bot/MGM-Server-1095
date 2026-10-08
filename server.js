const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  query_timeout: 5000,
});
pool.on('error', e => console.error('[db] pool error', e.message));

// ── Discord bot (/MGM) ──
let botClient = null;
try {
  const bot = require('./bot');
  if (process.env.DISCORD_TOKEN) {
    bot.start(pool).then(c => { botClient = c; console.log('[bot] started'); }).catch(e => console.error('[bot] failed to start:', e.message));
  } else {
    console.log('[bot] DISCORD_TOKEN not set — slash commands disabled');
  }
} catch (e) {
  console.error('[bot] load failed:', e.message);
}
if (!process.env.DATABASE_URL) console.error('[db] DATABASE_URL not set - registrations will fail');

pool.query(`
  CREATE TABLE IF NOT EXISTS registrations (
    discord_id TEXT PRIMARY KEY,
    discord_username TEXT,
    in_game_name TEXT NOT NULL,
    power BIGINT NOT NULL,
    participating BOOLEAN NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.error('DB init error:', err));

pool.query(`
  CREATE TABLE IF NOT EXISTS mgm_event (
    id INT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Murongs Grand Melee',
    event_at TIMESTAMPTZ,
    updated_by TEXT,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => pool.query(`INSERT INTO mgm_event (id, title) VALUES (1, 'Murongs Grand Melee') ON CONFLICT (id) DO NOTHING`)).catch(err => console.error('DB mgm_event init error:', err));

async function getEvent() {
  try { const { rows } = await pool.query('SELECT * FROM mgm_event WHERE id=1'); return rows[0] || { id: 1, title: 'Murongs Grand Melee', event_at: null }; } catch (e) { console.error('[db] getEvent failed', e.message); return { id: 1, title: 'Murongs Grand Melee', event_at: null }; }
}

app.set('trust proxy', 1); // Railway sits behind a proxy; required for secure cookies
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 }
}));

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

app.get('/auth/discord', (req, res) => {
  res.redirect(
    'https://discord.com/oauth2/authorize' +
    `?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    '&response_type=code&scope=identify%20guilds'
  );
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  const oauthErr = req.query.error;
  if (oauthErr) { console.error('[oauth] Discord error:', oauthErr, req.query.error_description); return res.redirect('/?error=token_failed'); }
  if (!code) return res.redirect('/?error=no_code');
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) { console.error('[oauth] Missing env', { hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET, redirectUri: REDIRECT_URI }); return res.redirect('/?error=server_error'); }
  console.log('[oauth] exchanging code, redirect_uri=', REDIRECT_URI, 'client_id=', CLIENT_ID);
  try {
    const controller = new AbortController();
    const tOut = setTimeout(() => controller.abort(), 10000);
    let tokenRes;
    try {
      tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI
        }),
        signal: controller.signal
      });
    } catch (fe) {
      clearTimeout(tOut);
      console.error('[oauth] fetch aborted/failed:', fe.message, fe.cause || '');
      return res.redirect('/?error=token_failed');
    }
    clearTimeout(tOut);
    console.log('[oauth] token response', tokenRes.status);
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('[oauth] token exchange failed:', tokenRes.status, JSON.stringify(tokens), 'redirect_uri=', REDIRECT_URI);
      return res.redirect('/?error=token_failed');
    }

    console.log('[oauth] token ok, fetching user+guilds');
    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    const fetchJson = async (url, label) => {
      const c = new AbortController();
      const to = setTimeout(() => c.abort(), 8000);
      try {
        const r = await fetch(url, { headers, signal: c.signal });
        clearTimeout(to);
        console.log('[oauth]', label, 'status', r.status);
        const j = await r.json();
        if (!r.ok) console.error('[oauth]', label, 'error body:', JSON.stringify(j).slice(0,500));
        return j;
      } catch (e) {
        clearTimeout(to);
        console.error('[oauth]', label, 'fetch failed:', e.message);
        throw e;
      }
    };
    let user, guilds;
    try {
      user = await fetchJson('https://discord.com/api/users/@me', 'users/@me');
      console.log('[oauth] user', user?.id, user?.username);
      guilds = await fetchJson('https://discord.com/api/users/@me/guilds', 'users/@me/guilds');
      console.log('[oauth] guilds', Array.isArray(guilds) ? guilds.length + ' guilds' : typeof guilds, Array.isArray(guilds) ? guilds.map(g=>g.id).slice(0,5).join(',') : JSON.stringify(guilds).slice(0,300));
    } catch (e) {
      console.error('[oauth] user/guild fetch failed:', e.message);
      return res.redirect('/?error=server_error');
    }

    const inGuild = Array.isArray(guilds) && guilds.some(g => g.id === GUILD_ID);
    console.log('[oauth] inGuild?', inGuild, 'wanted', GUILD_ID);
    if (!inGuild) {
      console.log('[oauth] access denied - not in guild');
      return res.status(403).render('error', {
        message: 'Access denied: You must be a member of the rush1095 Discord server.'
      });
    }
    req.session.user = { id: user.id, username: user.global_name || user.username };
    console.log('[oauth] login success', req.session.user);
    req.session.save(() => res.redirect('/'));
  } catch (err) {
    console.error('[oauth] callback error:', err.message, err.stack?.slice(0,500));
    res.redirect('/?error=server_error');
  }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

app.get('/api/event', async (req, res) => {
  const ev = await getEvent();
  res.json(ev);
});

app.put('/api/event', requireAuth, async (req, res) => {
  const raw = String(req.body.event_at || '').trim();
  const title = String(req.body.title || 'Murongs Grand Melee').trim().slice(0,100) || 'Murongs Grand Melee';
  let eventAt = null;
  if (raw) {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date/time' });
    eventAt = d.toISOString();
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO mgm_event (id, title, event_at, updated_by, updated_at) VALUES (1, $1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, event_at=EXCLUDED.event_at, updated_by=EXCLUDED.updated_by, updated_at=CURRENT_TIMESTAMP
       RETURNING *`,
      [title, eventAt, req.session.user.id]
    );
    console.log(`[event] updated by ${req.session.user.id} -> ${eventAt} "${title}"`);
    try {
      const bot = require('./bot');
      if (bot.updateEventChannel) { const c = bot.getClient && bot.getClient(); if (c) await bot.updateEventChannel(c, pool); }
    } catch {}
    res.json(rows[0]);
  } catch (e) {
    console.error('[event] update failed', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/', async (req, res) => {
  const user = req.session.user || null;
  let userReg = null;
  let registrations = [];
  let dbError = null;
  let mgmEvent = null;
  try { mgmEvent = await getEvent(); } catch {}
  if (user) {
    try {
      userReg = (await pool.query('SELECT * FROM registrations WHERE discord_id=$1', [user.id])).rows[0] || null;
    } catch (e) {
      console.error('[db] userReg query failed:', e.code, e.message);
      dbError = 'Database unreachable - registrations temporarily unavailable. Check DATABASE_URL in Railway variables.';
    }
    try {
      registrations = (await pool.query('SELECT * FROM registrations ORDER BY power DESC, in_game_name ASC')).rows;
    } catch (e) {
      console.error('[db] registrations query failed:', e.code, e.message);
      if (!dbError) dbError = 'Database unreachable - registrations temporarily unavailable.';
    }
  }
  res.render('index', { user, userReg, registrations, error: req.query.error, dbError, mgmEvent });
});

app.post('/register', async (req, res) => {
  if (!req.session.user) return res.redirect('/auth/discord');
  try {
    const name = String(req.body.in_game_name || '').trim().slice(0, 50);
    const power = parseInt(String(req.body.power || '').replace(/[^\d]/g, ''), 10);
    if (!name || !Number.isFinite(power) || power < 0) return res.redirect('/?error=invalid_input');
    await pool.query(
      `INSERT INTO registrations (discord_id, discord_username, in_game_name, power, participating, updated_at)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
       ON CONFLICT (discord_id) DO UPDATE SET
         discord_username=EXCLUDED.discord_username,
         in_game_name=EXCLUDED.in_game_name,
         power=EXCLUDED.power,
         participating=EXCLUDED.participating,
         updated_at=CURRENT_TIMESTAMP`,
      [req.session.user.id, req.session.user.username, name, power, req.body.participating === 'true']
    );
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.redirect('/?error=server_error');
  }
});

const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s; // prevent spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};

app.get('/export', async (req, res) => {
  if (!req.session.user) return res.redirect('/auth/discord');
  try {
    const rows = (await pool.query(
      'SELECT discord_username, in_game_name, power, participating, updated_at FROM registrations ORDER BY power DESC'
    )).rows;
    let csv = 'Discord Username,In-Game Name,Power,Participating,Updated At\n';
    rows.forEach(r => {
      csv += [csvCell(r.discord_username), csvCell(r.in_game_name), r.power,
              r.participating ? 'Yes' : 'No', csvCell(r.updated_at.toISOString())].join(',') + '\n';
    });
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment('mgm-participants.csv');
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).send('Database error');
  }
});

app.get('/auth/debug', async (req, res) => {
  let dbOk = null;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (e) { dbOk = e.code + ': ' + e.message.slice(0,120); }
  res.json({ hasClientId: !!CLIENT_ID, clientId: CLIENT_ID || null, redirectUri: REDIRECT_URI || null, hasSecret: !!CLIENT_SECRET, guildId: GUILD_ID || null, nodeEnv: process.env.NODE_ENV || null, hasDatabaseUrl: !!process.env.DATABASE_URL, dbStatus: dbOk, hasDiscordToken: !!process.env.DISCORD_TOKEN, mgmChannelId: process.env.MGM_CHANNEL_ID || process.env.MGM_LIST_CHANNEL_ID || null, botReady: !!(botClient && botClient.isReady && botClient.isReady()) });
});

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !GUILD_ID) console.error('[startup] Missing env:', { hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET, redirectUri: REDIRECT_URI, guildId: GUILD_ID });
else console.log('[startup] OAuth configured: client', CLIENT_ID, 'redirect', REDIRECT_URI, 'guild', GUILD_ID);

app.listen(PORT, () => console.log(`MGM running on ${PORT}`));

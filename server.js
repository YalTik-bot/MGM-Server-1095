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
    : { rejectUnauthorized: false }
});

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
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('[oauth] token exchange failed:', tokenRes.status, JSON.stringify(tokens), 'redirect_uri=', REDIRECT_URI);
      return res.redirect('/?error=token_failed');
    }

    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    const user = await fetch('https://discord.com/api/users/@me', { headers }).then(r => r.json());
    const guilds = await fetch('https://discord.com/api/users/@me/guilds', { headers }).then(r => r.json());

    const inGuild = Array.isArray(guilds) && guilds.some(g => g.id === GUILD_ID);
    if (!inGuild) {
      return res.status(403).render('error', {
        message: 'Access denied: You must be a member of the rush1095 Discord server.'
      });
    }
    req.session.user = { id: user.id, username: user.global_name || user.username };
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/?error=server_error');
  }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/', async (req, res) => {
  try {
    const user = req.session.user || null;
    let userReg = null;
    let registrations = [];
    if (user) {
      userReg = (await pool.query('SELECT * FROM registrations WHERE discord_id=$1', [user.id])).rows[0] || null;
      registrations = (await pool.query('SELECT * FROM registrations ORDER BY power DESC, in_game_name ASC')).rows;
    }
    res.render('index', { user, userReg, registrations, error: req.query.error });
  } catch (e) {
    console.error(e);
    res.status(500).send('Database error');
  }
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

app.get('/auth/debug', (req, res) => res.json({ hasClientId: !!CLIENT_ID, clientId: CLIENT_ID || null, redirectUri: REDIRECT_URI || null, hasSecret: !!CLIENT_SECRET, guildId: GUILD_ID || null, nodeEnv: process.env.NODE_ENV || null }));

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !GUILD_ID) console.error('[startup] Missing env:', { hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET, redirectUri: REDIRECT_URI, guildId: GUILD_ID });
else console.log('[startup] OAuth configured: client', CLIENT_ID, 'redirect', REDIRECT_URI, 'guild', GUILD_ID);

app.listen(PORT, () => console.log(`MGM running on ${PORT}`));

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
if (!process.env.DATABASE_URL) console.error('[db] DATABASE_URL not set - registrations will fail');

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

// ── DB init: registrations + mgm_events (multi-event) ──
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS registrations (
        discord_id TEXT,
        discord_username TEXT,
        in_game_name TEXT NOT NULL,
        power BIGINT NOT NULL,
        participating BOOLEAN NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        event_id INT
      )
    `);
  } catch (e) { console.error('registrations init', e.message); }

  // Ensure event_id column exists (for old DBs)
  try { await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS event_id INT`); } catch {}

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mgm_events (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'Murongs Grand Melee',
        event_at TIMESTAMPTZ,
        created_by TEXT,
        updated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) { console.error('mgm_events init', e.message); }

  // Migrate old mgm_event (single row) -> mgm_events
  try {
    const hasOld = await pool.query(`SELECT to_regclass('public.mgm_event') as c`);
    const oldExists = hasOld.rows[0].c !== null;
    if (oldExists) {
      const oldRows = await pool.query(`SELECT * FROM mgm_event LIMIT 1`).catch(()=>({rows:[]}));
      if (oldRows.rows && oldRows.rows.length) {
        const cnt = await pool.query(`SELECT COUNT(*) FROM mgm_events`);
        if (parseInt(cnt.rows[0].count,10) === 0) {
          const r = oldRows.rows[0];
          await pool.query(`INSERT INTO mgm_events (title, event_at, created_by, updated_by) VALUES ($1,$2,$3,$4)`, [r.title || 'Murongs Grand Melee', r.event_at || null, r.updated_by || null, r.updated_by || null]);
          console.log('[db] Migrated mgm_event -> mgm_events');
        }
      }
    }
  } catch (e) { console.error('migrate mgm_event', e.message); }

  // Ensure at least one event exists
  try {
    const cnt = await pool.query(`SELECT COUNT(*) FROM mgm_events`);
    if (parseInt(cnt.rows[0].count,10) === 0) {
      await pool.query(`INSERT INTO mgm_events (title) VALUES ('Murongs Grand Melee')`);
      console.log('[db] Created initial mgm_events row');
    }
  } catch (e) { console.error('ensure event', e.message); }

  // Backfill registrations.event_id
  try {
    const firstEv = await pool.query(`SELECT id FROM mgm_events ORDER BY id ASC LIMIT 1`);
    const fid = firstEv.rows[0]?.id;
    if (fid) await pool.query(`UPDATE registrations SET event_id=$1 WHERE event_id IS NULL`, [fid]);
  } catch (e) { console.error('backfill registrations', e.message); }

  // Fix PK to be (discord_id, event_id) so same user can register for different events
  try {
    // Drop old PK if it's only discord_id
    const pk = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid='registrations'::regclass AND contype='p'`).catch(()=>({rows:[]}));
    if (pk.rows && pk.rows.length) {
      const name = pk.rows[0].conname;
      // Check if PK column is single discord_id
      const cols = await pool.query(`SELECT array_agg(a.attname) as cols FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey) WHERE c.conname=$1`, [name]).catch(()=>({rows:[]}));
      const colList = cols.rows[0]?.cols || [];
      if (colList.length === 1 && colList[0] === 'discord_id') {
        await pool.query(`ALTER TABLE registrations DROP CONSTRAINT "${name}"`);
        console.log('[db] Dropped old PK', name);
        await pool.query(`ALTER TABLE registrations ADD PRIMARY KEY (discord_id, event_id)`);
        console.log('[db] Added composite PK (discord_id, event_id)');
      }
    } else {
      // No PK - try to add composite
      await pool.query(`ALTER TABLE registrations ADD PRIMARY KEY (discord_id, event_id)`).catch(()=>{});
    }
  } catch (e) { console.error('PK migration', e.message); }

  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_registrations_event_id ON registrations(event_id)`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_mgm_events_created_at ON mgm_events(created_at DESC)`); } catch {}
}
initDb().catch(e => console.error('initDb failed', e));

// Helpers
async function getCurrentEvent() {
  try {
    const { rows } = await pool.query(`SELECT * FROM mgm_events ORDER BY id DESC LIMIT 1`);
    return rows[0] || null;
  } catch (e) { console.error('[db] getCurrentEvent', e.message); return null; }
}
async function getEventById(id) {
  try { const { rows } = await pool.query(`SELECT * FROM mgm_events WHERE id=$1`, [id]); return rows[0] || null; } catch (e) { return null; }
}
async function listEvents() {
  try { const { rows } = await pool.query(`SELECT * FROM mgm_events ORDER BY id DESC`); return rows; } catch (e) { return []; }
}

app.set('trust proxy', 1);
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

// ── Auth helper ──
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ── API: events ──
app.get('/api/events', async (req, res) => {
  const evs = await listEvents();
  res.json(evs);
});

app.get('/api/event', async (req, res) => {
  const ev = await getCurrentEvent();
  res.json(ev || {});
});
app.get('/api/event/:id', async (req, res) => {
  const ev = await getEventById(parseInt(req.params.id,10));
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  res.json(ev);
});

// Create new event — everyone can (as requested)
app.post('/api/events', requireAuth, async (req, res) => {
  const title = String(req.body.title || 'Murongs Grand Melee').trim().slice(0,100) || 'Murongs Grand Melee';
  const raw = String(req.body.event_at || '').trim();
  let eventAt = null;
  if (raw) { const d = new Date(raw); if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date/time' }); eventAt = d.toISOString(); }
  try {
    const { rows } = await pool.query(
      `INSERT INTO mgm_events (title, event_at, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING *`,
      [title, eventAt, req.session.user.id]
    );
    console.log(`[event] created ${rows[0].id} by ${req.session.user.id} -> ${eventAt} "${title}"`);
    const createdUtc = eventAt ? new Date(eventAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC' : 'TBA';
    try {
      const bot = require('./bot');
      if (bot.updateEventChannel) { const c = bot.getClient && bot.getClient(); if (c) await bot.updateEventChannel(c, pool); }
      // Ping Alliance members in MGM channel (website creation)
      const allianceMention2 = process.env.ALLIANCE_ROLE_ID ? `<@&${process.env.ALLIANCE_ROLE_ID}>` : '@Alliance members';
      const listId = process.env.MGM_CHANNEL_ID || process.env.MGM_LIST_CHANNEL_ID;
      if (listId) {
        const c2 = bot.getClient && bot.getClient();
        if (c2) {
          const ch2 = await c2.channels.fetch(listId).catch(() => null);
          if (ch2 && ch2.isTextBased()) {
            await ch2.send({ content: `${allianceMention2} — New MGM event **${title}** — ${createdUtc} — register with \`/mgm register\`!`, allowedMentions: process.env.ALLIANCE_ROLE_ID ? { roles: [process.env.ALLIANCE_ROLE_ID] } : { parse: [] } }).catch(() => {});
          }
        }
      }
    } catch {}
    res.json(rows[0]);
  } catch (e) { console.error('[event] create failed', e.message); res.status(500).json({ error: 'Database error' }); }
});

// Update event (date/title) — everyone can update any event (participants re-register not affected)
app.put('/api/event/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id,10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const title = String(req.body.title || '').trim().slice(0,100);
  const raw = String(req.body.event_at || '').trim();
  let eventAt = null;
  let hasDate = false;
  if ('event_at' in req.body) {
    hasDate = true;
    if (raw) { const d = new Date(raw); if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date/time' }); eventAt = d.toISOString(); }
    else eventAt = null;
  }
  try {
    let ev = await getEventById(id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const newTitle = title || ev.title;
    const newDate = hasDate ? eventAt : ev.event_at;
    const { rows } = await pool.query(`UPDATE mgm_events SET title=$1, event_at=$2, updated_by=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *`, [newTitle, newDate, req.session.user.id, id]);
    console.log(`[event] updated ${id} by ${req.session.user.id} -> ${newDate} "${newTitle}"`);
    try { const bot = require('./bot'); if (bot.updateEventChannel) { const c = bot.getClient && bot.getClient(); if (c) await bot.updateEventChannel(c, pool); } } catch {}
    res.json(rows[0]);
  } catch (e) { console.error('[event] update failed', e.message); res.status(500).json({ error: 'Database error' }); }
});

// Legacy PUT /api/event (no id) -> updates current event
app.put('/api/event', requireAuth, async (req, res) => {
  const cur = await getCurrentEvent();
  if (!cur) return res.status(404).json({ error: 'No event' });
  const title = String(req.body.title || '').trim().slice(0,100);
  const hasDate = 'event_at' in req.body;
  let eventAt = cur.event_at;
  if (hasDate) {
    const raw = String(req.body.event_at || '').trim();
    if (raw) { const d=new Date(raw); if(isNaN(d.getTime())) return res.status(400).json({error:'Invalid date/time'}); eventAt=d.toISOString(); }
    else eventAt=null;
  }
  const newTitle = title || cur.title;
  try {
    const { rows } = await pool.query(`UPDATE mgm_events SET title=$1, event_at=$2, updated_by=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *`, [newTitle, eventAt, req.session.user.id, cur.id]);
    try { const bot=require('./bot'); if(bot.updateEventChannel){ const c=bot.getClient&&bot.getClient(); if(c) await bot.updateEventChannel(c, pool); } } catch {}
    return res.json(rows[0]);
  } catch(e){ return res.status(500).json({error:'Database error'}); }
});

// ── Page: home (current event) ──
app.get('/', async (req, res) => {
  const user = req.session.user || null;
  let userReg = null;
  let registrations = [];
  let dbError = null;
  let mgmEvent = await getCurrentEvent();
  const allEvents = await listEvents();
  if (!mgmEvent && allEvents.length) mgmEvent = allEvents[0];
  const currentId = mgmEvent?.id || null;
  if (user && currentId) {
    try { userReg = (await pool.query('SELECT * FROM registrations WHERE discord_id=$1 AND event_id=$2', [user.id, currentId])).rows[0] || null; } catch (e) { console.error('[db] userReg', e.code, e.message); dbError = 'Database unreachable - registrations temporarily unavailable.'; }
    try { registrations = (await pool.query('SELECT * FROM registrations WHERE event_id=$1 ORDER BY power DESC, in_game_name ASC', [currentId])).rows; } catch (e) { console.error('[db] regs', e.code, e.message); if (!dbError) dbError = 'Database unreachable.'; }
  }
  res.render('index', { user, userReg, registrations, error: req.query.error, dbError, mgmEvent, allEvents, currentEventId: currentId });
});

// ── Page: specific event ──
app.get('/event/:id', async (req, res) => {
  const user = req.session.user || null;
  const id = parseInt(req.params.id,10);
  const mgmEvent = await getEventById(id);
  if (!mgmEvent) return res.status(404).render('error', { message: 'Event not found.' });
  const allEvents = await listEvents();
  let userReg = null, registrations = [], dbError = null;
  if (user) {
    try { userReg = (await pool.query('SELECT * FROM registrations WHERE discord_id=$1 AND event_id=$2', [user.id, id])).rows[0] || null; } catch (e) { dbError = 'Database unreachable.'; }
    try { registrations = (await pool.query('SELECT * FROM registrations WHERE event_id=$1 ORDER BY power DESC, in_game_name ASC', [id])).rows; } catch (e) { if (!dbError) dbError = 'Database unreachable.'; }
  }
  res.render('index', { user, userReg, registrations, error: req.query.error, dbError, mgmEvent, allEvents, currentEventId: id });
});

// ── Register (for current event when POST to /register, or for specific event via hidden field) ──
app.post('/register', async (req, res) => {
  if (!req.session.user) return res.redirect('/auth/discord');
  try {
    const eventId = parseInt(req.body.event_id,10) || (await getCurrentEvent())?.id;
    if (!eventId) return res.redirect('/?error=server_error');
    const ev = await getEventById(eventId);
    if (!ev) return res.redirect('/?error=server_error');
    const name = String(req.body.in_game_name || '').trim().slice(0, 50);
    const power = parseInt(String(req.body.power || '').replace(/[^0-9]/g, ''), 10);
    if (!name || !Number.isFinite(power) || power < 0) return res.redirect(`/event/${eventId}?error=invalid_input`);
    const participating = req.body.participating === 'true';
    await pool.query(
      `INSERT INTO registrations (discord_id, discord_username, in_game_name, power, participating, updated_at, event_id)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,$6)
       ON CONFLICT (discord_id, event_id) DO UPDATE SET discord_username=EXCLUDED.discord_username, in_game_name=EXCLUDED.in_game_name, power=EXCLUDED.power, participating=EXCLUDED.participating, updated_at=CURRENT_TIMESTAMP`,
      [req.session.user.id, req.session.user.username, name, power, participating, eventId]
    );
    try { const bot = require('./bot'); if (bot.updateEventChannel) { const c = bot.getClient && bot.getClient(); if (c) await bot.updateEventChannel(c, pool); } } catch {}
    res.redirect(`/event/${eventId}`);
  } catch (e) { console.error(e); res.redirect('/?error=server_error'); }
});

// Keep old POST /register without event_id working (redirects to current)
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

app.get('/export', async (req, res) => {
  if (!req.session.user) return res.redirect('/auth/discord');
  const eventId = parseInt(req.query.event_id,10) || (await getCurrentEvent())?.id;
  if (!eventId) return res.status(404).send('No event');
  try {
    const rows = (await pool.query('SELECT discord_username, in_game_name, power, participating, updated_at FROM registrations WHERE event_id=$1 ORDER BY power DESC', [eventId])).rows;
    let csv = 'Discord Username,In-Game Name,Power,Participating,Updated At\n';
    rows.forEach(r => { csv += [csvCell(r.discord_username), csvCell(r.in_game_name), r.power, r.participating ? 'Yes' : 'No', csvCell(r.updated_at.toISOString())].join(',') + '\n'; });
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`mgm-event-${eventId}-participants.csv`);
    res.send(csv);
  } catch (e) { console.error(e); res.status(500).send('Database error'); }
});

app.get('/auth/debug', async (req, res) => {
  let dbOk = null;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (e) { dbOk = e.code + ': ' + e.message.slice(0,120); }
  const evCount = await pool.query(`SELECT COUNT(*) FROM mgm_events`).then(r=>parseInt(r.rows[0].count,10)).catch(()=>null);
  res.json({ hasClientId: !!CLIENT_ID, clientId: CLIENT_ID || null, redirectUri: REDIRECT_URI || null, hasSecret: !!CLIENT_SECRET, guildId: GUILD_ID || null, nodeEnv: process.env.NODE_ENV || null, hasDatabaseUrl: !!process.env.DATABASE_URL, dbStatus: dbOk, hasDiscordToken: !!process.env.DISCORD_TOKEN, mgmChannelId: process.env.MGM_CHANNEL_ID || process.env.MGM_LIST_CHANNEL_ID || null, botReady: !!(botClient && botClient.isReady && botClient.isReady()), eventCount: evCount, currentEventId: (await getCurrentEvent())?.id || null });
});

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !GUILD_ID) console.error('[startup] Missing env:', { hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET, redirectUri: REDIRECT_URI, guildId: GUILD_ID });
else console.log('[startup] OAuth configured: client', CLIENT_ID, 'redirect', REDIRECT_URI, 'guild', GUILD_ID);

app.listen(PORT, () => console.log(`MGM running on ${PORT}`));

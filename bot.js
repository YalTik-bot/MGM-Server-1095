// MGM Discord Bot — /mgm register + list (single dedicated channel)
const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, REST, Routes,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder
} = require('discord.js');

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const LIST_CHANNEL_ID = process.env.MGM_CHANNEL_ID || process.env.MGM_LIST_CHANNEL_ID || null;

function fmtPower(n) { return Number(n).toLocaleString('en-US'); }

function getBoardUrl(eventRow) {
  const id = eventRow?.id;
  if (!id) return null;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/event/${id}`;
  if (process.env.DISCORD_REDIRECT_URI) { try { return new URL(process.env.DISCORD_REDIRECT_URI).origin + `/event/${id}`; } catch {} }
  return null;
}

function buildListEmbed(registrations, guildName, eventRow, opts = {}) {
  const page = Math.max(0, opts.page | 0);
  const pageSize = 15;
  const going = registrations.filter(r => r.participating);
  const notGoing = registrations.filter(r => !r.participating);
  const total = registrations.length;
  const trunc = (s, max = 1024) => s.length > max ? s.slice(0, max - 20).replace(/\n[^\n]*$/, '') + '\n_and more on dashboard_' : s;
  const totalPower = registrations.reduce((a, r) => a + Number(r.power || 0), 0);
  const avgPower = total ? Math.round(totalPower / total) : 0;
  const goingPower = going.reduce((a, r) => a + Number(r.power || 0), 0);
  const line = r => {
    const discord = r.discord_username && r.discord_username !== r.in_game_name ? ` · _${r.discord_username}_` : '';
    return `**${r.in_game_name}**${discord} — \`${fmtPower(r.power)}\``;
  };
  const goingText = going.length ? going.map(line).join('\n') : '_Nobody yet — tap **Register / Edit**_';
  const notGoingText = notGoing.length ? notGoing.map(line).join('\n') : '_Nobody_';
  const ev = eventRow ? formatEventLine(eventRow.event_at) : null;
  let descEvent;
  if (ev) descEvent = `📅 **Event:** ${ev.utc}`;
  else descEvent = `📅 **Event:** _Not set yet — set a date on the dashboard_`;
  const statsLine = total
    ? `**Total:** **${total}** · ✅ ${going.length} going · ❌ ${notGoing.length} not going · ⚡ ${fmtPower(totalPower)} total (avg ${fmtPower(avgPower)})`
    : `**Total:** **0** · no registrations yet`;
  const helpShort = `Tap **Register / Edit** or type \`/mgm register\` → name + power + \`yes\`/\`no\` — then toggle **I'm Going ✅** / **Not Going ❌**`;
  const boardUrl = opts.boardUrl || getBoardUrl(eventRow);
  const embed = new EmbedBuilder()
    .setTitle(eventRow?.title || 'Murongs Grand Melee — Server 1095')
    .setDescription(`${descEvent}\n${statsLine}`)
    .setColor(0xf59e0b)
    .setTimestamp(new Date());
  if (boardUrl) embed.setURL(boardUrl);
  if (opts.guildIconURL) embed.setThumbnail(opts.guildIconURL);
  const footerParts = [];
  if (guildName) footerParts.push(guildName);
  if (eventRow?.id) footerParts.push(`Event #${eventRow.id}`);
  const hh = new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  footerParts.push(`updated ${hh} UTC`);
  embed.setFooter({ text: footerParts.join(' · ') });

  // Optional: viewer-specific status (when triggered by a user action, not the global refresh)
  if (opts.viewerId) {
    const me = registrations.find(r => r.discord_id === opts.viewerId);
    if (me) {
      const rank = [...registrations].sort((a, b) => Number(b.power) - Number(a.power)).findIndex(r => r.discord_id === opts.viewerId) + 1;
      embed.addFields({ name: `👤 You`, value: `**${me.in_game_name}** — \`${fmtPower(me.power)}\` ${me.participating ? '✅ Going' : '❌ Not Going'}${rank ? ` · rank #${rank}` : ''}`, inline: false });
    }
  }

  embed.addFields(
    { name: `✅ Going — ${going.length}${going.length ? ` · ${fmtPower(goingPower)}` : ''}`, value: trunc(goingText), inline: false },
    { name: `❌ Not Going — ${notGoing.length}`, value: trunc(notGoingText), inline: false },
  );
  if (total > 0) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const cur = Math.min(page, totalPages - 1);
    const slice = registrations.slice(cur * pageSize, cur * pageSize + pageSize);
    const top = slice.map((r, i) => {
      const abs = cur * pageSize + i;
      const medal = abs === 0 ? '🥇' : abs === 1 ? '🥈' : abs === 2 ? '🥉' : `**${abs + 1}.**`;
      return `${medal} **${r.in_game_name}** — \`${fmtPower(r.power)}\` ${r.participating ? '✅' : '❌'}`;
    }).join('\n');
    const label = totalPages > 1 ? `🏆 Top by Power — page ${cur + 1}/${totalPages}` : `🏆 Top by Power`;
    const more = totalPages > 1 ? `\n_page ${cur + 1} of ${totalPages} · full list on dashboard_` : (total > pageSize ? `\n_and ${total - pageSize} more on dashboard_` : '');
    embed.addFields({ name: label, value: trunc(top + more, 1024), inline: false });
  }
  const howVal = total > 50
    ? helpShort + `\n\`/mgm status\` · prev/next top list below · full export on dashboard`
    : helpShort + `\n\`/mgm status\` · \`/mgm list\` · new board: \`/mgm event when:2026-11-02 19:00\` (UTC, empty = TBA)`;
  embed.addFields({ name: '📋 How to', value: howVal, inline: false });
  return embed;
}

function buildListComponents(eventRow, total, page) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgm_join').setLabel("I'm Going ✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mgm_leave').setLabel('Not Going ❌').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgm_register').setLabel('Register / Edit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mgm_refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
    ),
  ];
  const boardUrl = getBoardUrl(eventRow);
  if (boardUrl) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('🔗 Open Dashboard').setStyle(ButtonStyle.Link).setURL(boardUrl),
    ));
  }
  if (typeof total === 'number' && total > 15) {
    const pageSize = 15;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const cur = Math.max(0, Math.min(page | 0, totalPages - 1));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mgm_top_prev:${cur}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(cur <= 0),
      new ButtonBuilder().setCustomId(`mgm_top_next:${cur}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(cur >= totalPages - 1),
    ));
  }
  // Discord limits 5 rows — cap if both dashboard + pagination present we have 4 rows max, safe
  return rows.slice(0, 5);
}

async function getCurrentEventId(pool) {
  try { const { rows } = await pool.query('SELECT id FROM mgm_events ORDER BY id DESC LIMIT 1'); return rows[0]?.id || null; } catch { return null; }
}
async function getCurrentEventRowById(pool, id) {
  try { const { rows } = await pool.query('SELECT * FROM mgm_events WHERE id=$1', [id]); return rows[0] || null; } catch { return null; }
}
async function fetchRegistrations(pool, eventId = null) {
  let eid = eventId;
  if (!eid) eid = await getCurrentEventId(pool);
  if (!eid) return [];
  const { rows } = await pool.query('SELECT * FROM registrations WHERE event_id=$1 ORDER BY power DESC, in_game_name ASC', [eid]);
  return rows;
}
async function upsertRegistration(pool, discordId, discordUsername, inGameName, power, participating, eventId = null) {
  let eid = eventId;
  if (!eid) eid = await getCurrentEventId(pool);
  if (!eid) throw new Error('No event');
  try {
    await pool.query(
      `INSERT INTO registrations (discord_id, discord_username, in_game_name, power, participating, updated_at, event_id)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,$6)
       ON CONFLICT (discord_id, event_id) DO UPDATE SET
         discord_username=EXCLUDED.discord_username,
         in_game_name=EXCLUDED.in_game_name,
         power=EXCLUDED.power,
         participating=EXCLUDED.participating,
         updated_at=CURRENT_TIMESTAMP`,
      [discordId, discordUsername, inGameName, power, participating, eid]
    );
  } catch (e) {
    // 42P10 = no unique constraint matching ON CONFLICT — DB still on old schema (e.g. after Railway restore)
    if (e.code === '42P10' || String(e.message).includes('ON CONFLICT')) {
      console.warn('[db] upsert fallback (no constraint) for', discordId);
      const ex = await pool.query('SELECT 1 FROM registrations WHERE discord_id=$1 AND event_id=$2', [discordId, eid]);
      if (ex.rows.length) {
        await pool.query('UPDATE registrations SET discord_username=$1, in_game_name=$2, power=$3, participating=$4, updated_at=CURRENT_TIMESTAMP WHERE discord_id=$5 AND event_id=$6', [discordUsername, inGameName, power, participating, discordId, eid]);
      } else {
        await pool.query('INSERT INTO registrations (discord_id, discord_username, in_game_name, power, participating, updated_at, event_id) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,$6)', [discordId, discordUsername, inGameName, power, participating, eid]);
      }
    } else throw e;
  }
  return eid;
}

async function updateListChannel(client, pool, opts = {}) {
  if (!LIST_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LIST_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.isTextBased()) { console.log('[bot] MGM list channel not found:', LIST_CHANNEL_ID); return; }
    const regs = await fetchRegistrations(pool);
    const eventRow = await getEventRow(pool);
    const page = Math.max(0, opts.page | 0);
    const guildIconURL = ch.guild?.iconURL?.({ extension: 'png', size: 128 }) || null;
    const embed = buildListEmbed(regs, ch.guild?.name || null, eventRow, { page, guildIconURL });
    const components = buildListComponents(eventRow, regs.length, page);

    let target = null;

    // 1) Prefer pinned board — stays visible via pinned messages even when chat is busy
    try {
      const pinned = await ch.messages.fetchPins().catch(() => null);
      if (pinned && pinned.items) {
        for (const it of pinned.items) {
          const m = it.message || it;
          if (m?.author?.id === client.user.id && m.embeds?.length && m.embeds[0].title?.includes('Murongs Grand Melee')) { target = m; break; }
        }
      } else if (pinned && typeof pinned.values === 'function') {
        for (const m of pinned.values()) {
          if (m.author.id === client.user.id && m.embeds.length && m.embeds[0].title?.includes('Murongs Grand Melee')) { target = m; break; }
        }
      }
    } catch {}

    // 2) Fallback: recent messages
    if (!target) {
      const msgs = await ch.messages.fetch({ limit: 20 }).catch(() => null);
      if (msgs) {
        for (const m of msgs.values()) {
          if (m.author.id === client.user.id && m.embeds.length && m.embeds[0].title?.includes('Murongs Grand Melee')) { target = m; break; }
        }
      }
    }

    let finalMsg = null;
    if (target) {
      try { finalMsg = await target.edit({ embeds: [embed], components }); } catch { finalMsg = await ch.send({ embeds: [embed], components }); }
    } else {
      finalMsg = await ch.send({ embeds: [embed], components });
      if (!finalMsg) console.log('[bot] updateListChannel self-heal: board was deleted, recreated');
    }

    // Pin so it stays on top via Pinned messages (needs Manage Messages). Suppress the auto pin system message.
    if (finalMsg && !finalMsg.pinned) {
      await finalMsg.pin().catch(e => console.log('[bot] pin failed (need Manage Messages):', e.message));
      try {
        const recent = await ch.messages.fetch({ limit: 5 }).catch(() => null);
        if (recent) {
          for (const m of recent.values()) {
            if (m.type === 6) { await m.delete().catch(() => {}); break; }
          }
        }
      } catch {}
    }

    // Housekeeping: unpin stale MGM boards when a new event started (keep only current board pinned)
    if (finalMsg?.pinned && opts.unpinOld) {
      try {
        const pinned2 = await ch.messages.fetchPins().catch(() => null);
        const items = pinned2?.items || (pinned2 && typeof pinned2.values === 'function' ? [...pinned2.values()].map(m => ({ message: m })) : []);
        for (const it of (items || [])) {
          const m = it.message || it;
          if (m.id !== finalMsg.id && m.author?.id === client.user.id && m.embeds?.[0]?.title?.includes('Murongs Grand Melee')) {
            await m.unpin().catch(() => {});
            console.log('[bot] unpinned stale board', m.id);
          }
        }
      } catch {}
    }

    console.log(`[bot] Updated MGM list in #${ch.name} (${regs.length} regs)${finalMsg?.pinned ? ' pinned' : ''} page ${page}`);
  } catch (e) {
    console.error('[bot] updateListChannel failed:', e.message);
  }
}

function buildMgmCommand() {
  return new SlashCommandBuilder()
    .setName('mgm')
    .setDescription('Murongs Grand Melee — Server 1095')
    .addSubcommand(sc => sc.setName('register').setDescription('Register or update: name + power + going'))
    .addSubcommand(sc => sc.setName('list').setDescription('Show who is going and who is not (posts in MGM channel)'))
    .addSubcommand(sc => sc.setName('status').setDescription('Show your own registration'))
    .addSubcommand(sc => sc.setName('event').setDescription('Create a new MGM event (fresh participant list)').addStringOption(o => o.setName('when').setDescription('Date & time UTC, e.g. 2026-10-20 19:00 or empty for TBA').setRequired(false)).addStringOption(o => o.setName('title').setDescription('Event title').setRequired(false)))
    .toJSON();
}

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.log('[bot] Skipping command registration — missing TOKEN/CLIENT_ID/GUILD_ID');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = [buildMgmCommand()];
  try {
    // Guild command = instant (1s), global = 1 hour. Use guild for now.
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log('[bot] Registered /mgm guild command for', GUILD_ID);
  } catch (e) {
    console.error('[bot] Command registration failed:', e.message, e.rawError || '');
  }
}

function buildRegisterModal() {
  const modal = new ModalBuilder().setCustomId('mgm_modal').setTitle('MGM — Register');
  const nameInput = new TextInputBuilder().setCustomId('in_game_name').setLabel('In-game name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50).setPlaceholder('e.g. YalTik');
  const powerInput = new TextInputBuilder().setCustomId('power').setLabel('Power (numbers, e.g. 45000000)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('45000000').setMaxLength(20);
  const partInput = new TextInputBuilder().setCustomId('participating').setLabel('Going? (yes / no)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('yes').setMaxLength(5);
  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(powerInput),
    new ActionRowBuilder().addComponents(partInput),
  );
  return modal;
}

let _client = null;
function getClient() { return _client; }

async function getEventRow(pool, eventId = null) {
  try {
    if (eventId) { const { rows } = await pool.query('SELECT * FROM mgm_events WHERE id=$1', [eventId]); return rows[0] || null; }
    const { rows } = await pool.query('SELECT * FROM mgm_events ORDER BY id DESC LIMIT 1'); return rows[0] || null;
  } catch { return null; }
}

function formatEventLine(eventAt) {
  if (!eventAt) return null;
  try {
    const d = new Date(eventAt);
    if (isNaN(d.getTime())) return null;
    const ts = Math.floor(d.getTime() / 1000);
    // Use Discord timestamp + human fallback; show UTC
    const utc = d.toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
    return { ts, utc, iso: d.toISOString() };
  } catch { return null; }
}

async function updateEventChannel(client, pool) { return updateListChannel(client, pool); }

async function start(pool) {
  if (!TOKEN) {
    console.log('[bot] DISCORD_TOKEN not set — bot disabled (dashboard still works)');
    return null;
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

  _client = client;
  client.once(Events.ClientReady, async () => {
    console.log(`[bot] Ready as ${client.user.tag} (${client.user.id}) — guild ${GUILD_ID} — list channel ${LIST_CHANNEL_ID || '(not set, uses command channel)'}`);
    await registerCommands();
    // Initial list update if channel configured
    if (LIST_CHANNEL_ID) await updateListChannel(client, pool);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // Slash command
      if (interaction.isChatInputCommand() && interaction.commandName === 'mgm') {
        const sub = interaction.options.getSubcommand(false) || 'register';
        const guildName = interaction.guild?.name || null;

        if (sub === 'status') {
          const eid = await getCurrentEventId(pool);
          const row = eid ? (await pool.query('SELECT * FROM registrations WHERE discord_id=$1 AND event_id=$2', [interaction.user.id, eid])).rows[0] : null;
          if (!row) return interaction.reply({ content: 'You are not registered yet for the current event. Use `/mgm register` to sign up.', ephemeral: true });
          const ev = await getEventRow(pool, eid);
          const evLabel = ev ? ` for **${ev.title}**` : '';
          return interaction.reply({ content: `**${row.in_game_name}** — Power \`${fmtPower(row.power)}\` — ${row.participating ? '✅ Going' : '❌ Not Going'}${evLabel}`, ephemeral: true });
        }

        if (sub === 'list') {
          const guildIconURL = interaction.guild?.iconURL?.({ extension: 'png', size: 128 }) || null;
          const regs = await fetchRegistrations(pool);
          const eventRow = await getEventRow(pool);
          const embed = buildListEmbed(regs, guildName, eventRow, { viewerId: interaction.user.id, guildIconURL });
          const components = buildListComponents(eventRow, regs.length, 0);
          // If LIST_CHANNEL_ID set, post there and confirm ephemerally
          if (LIST_CHANNEL_ID) {
            await updateListChannel(client, pool);
            const ch = await client.channels.fetch(LIST_CHANNEL_ID).catch(() => null);
            return interaction.reply({ content: ch ? `List refreshed in <#${LIST_CHANNEL_ID}> — ${regs.length} registrations.` : `List: ${regs.length} registrations.`, embeds: [embed], ephemeral: true });
          }
          // Otherwise post publicly in current channel
          return interaction.reply({ embeds: [embed], components });
        }

        if (sub === 'event') {
          const whenRaw = interaction.options.getString('when');
          const titleRaw = interaction.options.getString('title');
          const title = (titleRaw || '').trim().slice(0,100) || 'Murongs Grand Melee';
          let eventAt = null;
          if (whenRaw && whenRaw.trim()) {
            const normalized = whenRaw.trim().replace(' ', 'T') + ':00Z';
            const parsed = new Date(normalized);
            if (isNaN(parsed.getTime())) return interaction.reply({ content: '❌ Invalid date. Use `YYYY-MM-DD HH:MM` (e.g. `2026-10-20 19:00`) or leave empty for “TBA”.', ephemeral: true });
            eventAt = parsed.toISOString();
          }
          // B: create a NEW event (fresh participant list). Everyone can create.
          const { rows } = await pool.query('INSERT INTO mgm_events (title, event_at, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING *', [title, eventAt, interaction.user.id]);
          const newId = rows[0].id;
          const utcDesc = eventAt ? new Date(eventAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC' : 'TBA';
          await updateListChannel(client, pool, { unpinOld: true });
          // Ping Alliance members in the MGM channel (uses @Alliance members; if you have a role ID put it in ALLIANCE_ROLE_ID for a real ping)
          const allianceMention = process.env.ALLIANCE_ROLE_ID ? `<@&${process.env.ALLIANCE_ROLE_ID}>` : '@Alliance members';
          try {
            if (LIST_CHANNEL_ID) {
              const ch2 = await client.channels.fetch(LIST_CHANNEL_ID).catch(() => null);
              if (ch2 && ch2.isTextBased()) {
                await ch2.send({ content: `${allianceMention} — New MGM event **${title}** — ${utcDesc} — register with \`/mgm register\`!`, allowedMentions: process.env.ALLIANCE_ROLE_ID ? { roles: [process.env.ALLIANCE_ROLE_ID] } : { parse: [] } }).catch(() => {});
              }
            }
          } catch {}
          const dashUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/event/${newId}` : `/event/${newId}`;
          const chMention = LIST_CHANNEL_ID ? '<#' + LIST_CHANNEL_ID + '>' : 'the MGM channel';
          return interaction.reply({ content: `${allianceMention} ✅ **New event #${newId}** created: **${title}** — ${utcDesc}.\nParticipants start empty — everyone must re-register with \`/mgm register\`. Dashboard: ${dashUrl} • Board refreshed in ${chMention}.`, allowedMentions: process.env.ALLIANCE_ROLE_ID ? { roles: [process.env.ALLIANCE_ROLE_ID] } : { parse: [] } });
        }

        // register (default)
        const modal = buildRegisterModal();
        // Pre-fill not possible for modals, but we can hint via DB
        await interaction.showModal(modal);
        return;
      }

      // Modal submit
      if (interaction.isModalSubmit() && interaction.customId === 'mgm_modal') {
        await interaction.deferReply({ ephemeral: true });
        const inGameName = interaction.fields.getTextInputValue('in_game_name').trim().slice(0, 50);
        const powerRaw = interaction.fields.getTextInputValue('power').replace(/[^0-9]/g, '');
        const power = parseInt(powerRaw, 10);
        const partRaw = interaction.fields.getTextInputValue('participating').trim().toLowerCase();
        const participating = ['ja', 'yes', 'y', 'j', '1', 'true', 'aanwezig', 'mee'].includes(partRaw);

        if (!inGameName || !Number.isFinite(power) || power < 0) {
          return interaction.editReply({ content: '❌ Please enter a valid in-game name and power (e.g. 45000000).' });
        }
        const username = interaction.user.globalName || interaction.user.username;
        await upsertRegistration(pool, interaction.user.id, username, inGameName, power, participating);
        console.log(`[bot] upsert ${interaction.user.id} ${username} -> ${inGameName} ${power} ${participating ? 'yes' : 'no'}`);
        await updateListChannel(client, pool);
        const where = LIST_CHANNEL_ID ? `<#${LIST_CHANNEL_ID}>` : 'the list';
        return interaction.editReply({ content: `✅ Registered as **${inGameName}** — Power \`${fmtPower(power)}\` — ${participating ? '✅ Going' : '❌ Not Going'}. Visible in ${where}.` });
      }

      // Buttons
      if (interaction.isButton()) {
        const id = interaction.customId;
        if (id === 'mgm_register') {
          return interaction.showModal(buildRegisterModal());
        }
        if (id.startsWith('mgm_top_')) {
          const cur = parseInt(id.split(':')[1] || '0', 10) | 0;
          const isNext = id.startsWith('mgm_top_next');
          const nextPage = isNext ? cur + 1 : cur - 1;
          const regs = await fetchRegistrations(pool);
          const eventRow = await getEventRow(pool);
          const page = Math.max(0, nextPage);
          const totalPages = Math.max(1, Math.ceil(regs.length / 15));
          const clamped = Math.min(page, totalPages - 1);
          const guildIconURL = interaction.guild?.iconURL?.({ extension: 'png', size: 128 }) || null;
          const embed = buildListEmbed(regs, interaction.guild?.name || null, eventRow, { viewerId: interaction.user.id, guildIconURL, page: clamped });
          return interaction.update({ embeds: [embed], components: buildListComponents(eventRow, regs.length, clamped) });
        }
        if (id === 'mgm_refresh') {
          const regs = await fetchRegistrations(pool);
          const eventRow = await getEventRow(pool);
          const guildIconURL = interaction.guild?.iconURL?.({ extension: 'png', size: 128 }) || null;
          const embed = buildListEmbed(regs, interaction.guild?.name || null, eventRow, { viewerId: interaction.user.id, guildIconURL, page: 0 });
          return interaction.update({ embeds: [embed], components: buildListComponents(eventRow, regs.length, 0) });
        }
        if (id === 'mgm_join' || id === 'mgm_leave') {
          const want = id === 'mgm_join';
          const eid = await getCurrentEventId(pool);
          if (!eid) return interaction.reply({ content: 'No active event.', ephemeral: true });
          const row = (await pool.query('SELECT * FROM registrations WHERE discord_id=$1 AND event_id=$2', [interaction.user.id, eid])).rows[0];
          if (!row) {
            return interaction.reply({ content: 'You are not registered yet for the current event. Click **Register / Edit** first.', ephemeral: true });
          }
          await pool.query('UPDATE registrations SET participating=$1, updated_at=CURRENT_TIMESTAMP WHERE discord_id=$2 AND event_id=$3', [want, interaction.user.id, eid]);
          console.log(`[bot] ${interaction.user.id} toggle participating -> ${want}`);
          await updateListChannel(client, pool);
          // Update the message in place if it's the list embed, else ephemeral confirm
          try {
            const regs = await fetchRegistrations(pool);
            const evRow2 = await getEventRow(pool);
            const guildIconURL2 = interaction.guild?.iconURL?.({ extension: 'png', size: 128 }) || null;
            const embed = buildListEmbed(regs, interaction.guild?.name || null, evRow2, { viewerId: interaction.user.id, guildIconURL: guildIconURL2, page: 0 });
            if (interaction.message?.embeds?.length) await interaction.update({ embeds: [embed], components: buildListComponents(evRow2, regs.length, 0) });
            else await interaction.reply({ content: want ? '✅ You are now marked as **Going**.' : '❌ You are now marked as **Not Going**.', ephemeral: true });
          } catch {
            await interaction.reply({ content: want ? '✅ Going.' : '❌ Not Going.', ephemeral: true }).catch(() => {});
          }
          return;
        }
      }
    } catch (e) {
      console.error('[bot] interaction error:', e);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true }); else await interaction.editReply({ content: 'Something went wrong.' }); } catch {}
    }
  });

  client.on(Events.Error, e => console.error('[bot] client error', e.message));
  await client.login(TOKEN);
  return client;
}

module.exports = { start, buildListEmbed, buildListComponents, getBoardUrl, updateListChannel, updateEventChannel, getClient, getEventRow };

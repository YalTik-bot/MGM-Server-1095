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

function buildListEmbed(registrations, guildName, eventRow) {
  const going = registrations.filter(r => r.participating);
  const notGoing = registrations.filter(r => !r.participating);
  const total = registrations.length;
  const trunc = (s, max = 1024) => s.length > max ? s.slice(0, max - 20).replace(/\n[^\n]*$/, '') + '\n… and more' : s;
  const line = r => {
    const discord = r.discord_username && r.discord_username !== r.in_game_name ? ` · _${r.discord_username}_` : '';
    return `**${r.in_game_name}**${discord} — \`${fmtPower(r.power)}\``;
  };
  const goingText = going.length ? going.map(line).join('\n') : '_Nobody yet — tap **Register / Edit**_';
  const notGoingText = notGoing.length ? notGoing.map(line).join('\n') : '_Nobody_';
  const ev = eventRow ? formatEventLine(eventRow.event_at) : null;
  let descEvent;
  if (ev) {
    descEvent = `📅 **Event:** ${ev.utc}`;
  } else {
    descEvent = `📅 **Event:** _Not set yet — set a date on the dashboard_`;
  }
  const helpShort = `Tap **Register / Edit** or type \`/mgm register\` → name + power + \`yes\`/\`no\` — then toggle **I'm Going ✅** / **Not Going ❌**`;
  const embed = new EmbedBuilder()
    .setTitle(eventRow?.title || 'Murongs Grand Melee — Server 1095')
    .setDescription(`${descEvent}\n**Total:** **${total}** · ✅ ${going.length} going · ❌ ${notGoing.length} not going`)
    .setColor(0xf59e0b)
    .setTimestamp(new Date());
  if (guildName) embed.setFooter({ text: guildName + ' · updated' });
  embed.addFields(
    { name: `✅ Going — ${going.length}`, value: trunc(goingText), inline: false },
    { name: `❌ Not Going — ${notGoing.length}`, value: trunc(notGoingText), inline: false },
  );
  if (total > 0) {
    const top = registrations.slice(0, 15).map((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
      return `${medal} **${r.in_game_name}** — \`${fmtPower(r.power)}\` ${r.participating ? '✅' : '❌'}`;
    }).join('\n');
    const more = total > 15 ? `\n_and ${total - 15} more on dashboard_` : '';
    embed.addFields({ name: '🏆 Top by Power', value: trunc(top + more, 1024), inline: false });
  }
  embed.addFields({ name: '📋 How to', value: helpShort + `\n\`/mgm status\` · \`/mgm list\` · new board: \`/mgm event when:2026-11-02 19:00\` (UTC, empty = TBA)`, inline: false });
  return embed;
}

function buildListComponents() {
  // Two rows: primary actions together, secondary together — much more tappable on phones
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgm_join').setLabel("I'm Going ✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mgm_leave').setLabel('Not Going ❌').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgm_register').setLabel('Register / Edit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mgm_refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
    ),
  ];
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
  return eid;
}

async function updateListChannel(client, pool) {
  if (!LIST_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LIST_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.isTextBased()) { console.log('[bot] MGM list channel not found:', LIST_CHANNEL_ID); return; }
    const regs = await fetchRegistrations(pool);
    const eventRow = await getEventRow(pool);
    const embed = buildListEmbed(regs, ch.guild?.name || null, eventRow);
    const components = buildListComponents();

    // Find and update the last bot message in the channel, else send a new one
    // Look for recent messages by this bot
    const msgs = await ch.messages.fetch({ limit: 20 }).catch(() => null);
    let target = null;
    if (msgs) {
      for (const m of msgs.values()) {
        if (m.author.id === client.user.id && m.embeds.length && m.embeds[0].title?.includes('Murongs Grand Melee')) { target = m; break; }
      }
    }
    if (target) await target.edit({ embeds: [embed], components }).catch(async () => { await ch.send({ embeds: [embed], components }); });
    else await ch.send({ embeds: [embed], components });
    console.log(`[bot] Updated MGM list in #${ch.name} (${regs.length} regs)`);
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
          const regs = await fetchRegistrations(pool);
          const eventRow = await getEventRow(pool);
          const embed = buildListEmbed(regs, guildName, eventRow);
          const components = buildListComponents();
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
          await updateListChannel(client, pool);
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
        if (id === 'mgm_refresh') {
          const regs = await fetchRegistrations(pool);
          const eventRow = await getEventRow(pool);
          const embed = buildListEmbed(regs, interaction.guild?.name || null, eventRow);
          return interaction.update({ embeds: [embed], components: buildListComponents() });
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
            const embed = buildListEmbed(regs, interaction.guild?.name || null, await getEventRow(pool));
            if (interaction.message?.embeds?.length) await interaction.update({ embeds: [embed], components: buildListComponents() });
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

module.exports = { start, buildListEmbed, updateListChannel, updateEventChannel, getClient, getEventRow };

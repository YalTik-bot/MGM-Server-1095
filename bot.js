// MGM Discord Bot — /mgm register + lijst (list in één kanaal)
const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, REST, Routes,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder
} = require('discord.js');

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const LIST_CHANNEL_ID = process.env.MGM_CHANNEL_ID || process.env.MGM_LIST_CHANNEL_ID || null;

function fmtPower(n) { return Number(n).toLocaleString('nl-BE'); }

function buildListEmbed(registrations, guildName) {
  const yes = registrations.filter(r => r.participating);
  const no = registrations.filter(r => !r.participating);
  const total = registrations.length;

  const line = r => `**${r.in_game_name}** — ${r.discord_username} — \`${fmtPower(r.power)}\``;

  const yesText = yes.length ? yes.map(line).join('\n') : '_Niemand_';
  const noText = no.length ? no.map(line).join('\n') : '_Niemand_';

  // Discord embed field limit 1024 chars — truncate if needed
  const trunc = (s, max = 1024) => s.length > max ? s.slice(0, max - 20).replace(/\n[^\n]*$/, '') + '\n… en meer' : s;

  const embed = new EmbedBuilder()
    .setTitle('Murongs Grand Melee — Server 1095')
    .setDescription(`Totaal geregistreerd: **${total}** — groen = doet mee, rood = niet`)
    .setColor(0xf59e0b)
    .setTimestamp(new Date());

  if (guildName) embed.setFooter({ text: guildName });

  embed.addFields(
    { name: `✅ Aanwezig — ${yes.length}`, value: trunc(yesText), inline: false },
    { name: `❌ Niet aanwezig — ${no.length}`, value: trunc(noText), inline: false },
  );
  // Also a compact sorted table (top 25) as extra field if many entries
  if (total > 0) {
    const table = registrations.slice(0, 25).map((r, i) => `${String(i + 1).padStart(2, ' ')}. ${r.in_game_name.padEnd(16).slice(0, 16)}  ${fmtPower(r.power).padStart(10)}  ${r.participating ? '✅' : '❌'}`).join('\n');
    embed.addFields({ name: '🏆 Top 25 op Power', value: '```\n' + trunc(table, 1000) + '\n```', inline: false });
  }
  return embed;
}

function buildListComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgm_join').setLabel('Ik doe mee ✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mgm_leave').setLabel('Ik doe niet mee ❌').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgm_register').setLabel('Registreren / Wijzigen').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mgm_refresh').setLabel('🔄 Vernieuwen').setStyle(ButtonStyle.Secondary),
    )
  ];
}

async function fetchRegistrations(pool) {
  const { rows } = await pool.query('SELECT * FROM registrations ORDER BY power DESC, in_game_name ASC');
  return rows;
}

async function upsertRegistration(pool, discordId, discordUsername, inGameName, power, participating) {
  await pool.query(
    `INSERT INTO registrations (discord_id, discord_username, in_game_name, power, participating, updated_at)
     VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
     ON CONFLICT (discord_id) DO UPDATE SET
       discord_username=EXCLUDED.discord_username,
       in_game_name=EXCLUDED.in_game_name,
       power=EXCLUDED.power,
       participating=EXCLUDED.participating,
       updated_at=CURRENT_TIMESTAMP`,
    [discordId, discordUsername, inGameName, power, participating]
  );
}

async function updateListChannel(client, pool) {
  if (!LIST_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LIST_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.isTextBased()) { console.log('[bot] MGM list channel not found:', LIST_CHANNEL_ID); return; }
    const regs = await fetchRegistrations(pool);
    const embed = buildListEmbed(regs, ch.guild?.name || null);
    const components = buildListComponents();

    // Try to find and update last bot message in channel, else send new one
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
    .addSubcommand(sc => sc.setName('register').setDescription('Registreren of wijzigen: naam + power + meedoen'))
    .addSubcommand(sc => sc.setName('lijst').setDescription('Toon wie er meedoet en wie niet (post in MGM kanaal)'))
    .addSubcommand(sc => sc.setName('status').setDescription('Toon jouw eigen registratie'))
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
  const modal = new ModalBuilder().setCustomId('mgm_modal').setTitle('MGM — Registreren');
  const nameInput = new TextInputBuilder().setCustomId('in_game_name').setLabel('In-game naam').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50).setPlaceholder('bv. YalTik');
  const powerInput = new TextInputBuilder().setCustomId('power').setLabel('Power (cijfers, bv. 45000000)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('45000000').setMaxLength(20);
  const partInput = new TextInputBuilder().setCustomId('participating').setLabel('Meedoen? (ja / nee)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ja').setMaxLength(5);
  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(powerInput),
    new ActionRowBuilder().addComponents(partInput),
  );
  return modal;
}

async function start(pool) {
  if (!TOKEN) {
    console.log('[bot] DISCORD_TOKEN not set — bot disabled (dashboard still works)');
    return null;
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

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
          const row = (await pool.query('SELECT * FROM registrations WHERE discord_id=$1', [interaction.user.id])).rows[0];
          if (!row) return interaction.reply({ content: 'Je bent nog niet geregistreerd. Gebruik `/mgm register` om je aan te melden.', ephemeral: true });
          return interaction.reply({ content: `**${row.in_game_name}** — Power \`${fmtPower(row.power)}\` — ${row.participating ? '✅ Aanwezig' : '❌ Niet aanwezig'}`, ephemeral: true });
        }

        if (sub === 'lijst') {
          const regs = await fetchRegistrations(pool);
          const embed = buildListEmbed(regs, guildName);
          const components = buildListComponents();
          // If LIST_CHANNEL_ID set, post there and confirm ephemerally
          if (LIST_CHANNEL_ID) {
            await updateListChannel(client, pool);
            const ch = await client.channels.fetch(LIST_CHANNEL_ID).catch(() => null);
            return interaction.reply({ content: ch ? `Lijst ververst in <#${LIST_CHANNEL_ID}> — ${regs.length} registraties.` : `Lijst: ${regs.length} registraties.`, embeds: [embed], ephemeral: true });
          }
          // Otherwise post publicly in current channel
          return interaction.reply({ embeds: [embed], components });
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
          return interaction.editReply({ content: '❌ Vul een geldige in-game naam en power in (bv. 45000000).' });
        }
        const username = interaction.user.globalName || interaction.user.username;
        await upsertRegistration(pool, interaction.user.id, username, inGameName, power, participating);
        console.log(`[bot] upsert ${interaction.user.id} ${username} -> ${inGameName} ${power} ${participating ? 'ja' : 'nee'}`);
        await updateListChannel(client, pool);
        const where = LIST_CHANNEL_ID ? `<#${LIST_CHANNEL_ID}>` : 'de lijst';
        return interaction.editReply({ content: `✅ Geregistreerd als **${inGameName}** — Power \`${fmtPower(power)}\` — ${participating ? '✅ Aanwezig' : '❌ Niet aanwezig'}. Zichtbaar in ${where}.` });
      }

      // Buttons
      if (interaction.isButton()) {
        const id = interaction.customId;
        if (id === 'mgm_register') {
          return interaction.showModal(buildRegisterModal());
        }
        if (id === 'mgm_refresh') {
          const regs = await fetchRegistrations(pool);
          const embed = buildListEmbed(regs, interaction.guild?.name || null);
          return interaction.update({ embeds: [embed], components: buildListComponents() });
        }
        if (id === 'mgm_join' || id === 'mgm_leave') {
          const want = id === 'mgm_join';
          const row = (await pool.query('SELECT * FROM registrations WHERE discord_id=$1', [interaction.user.id])).rows[0];
          if (!row) {
            return interaction.reply({ content: 'Je bent nog niet geregistreerd. Klik op **Registreren / Wijzigen** eerst.', ephemeral: true });
          }
          await pool.query('UPDATE registrations SET participating=$1, updated_at=CURRENT_TIMESTAMP WHERE discord_id=$2', [want, interaction.user.id]);
          console.log(`[bot] ${interaction.user.id} toggle participating -> ${want}`);
          await updateListChannel(client, pool);
          // Update the message in place if it's the list embed, else ephemeral confirm
          try {
            const regs = await fetchRegistrations(pool);
            const embed = buildListEmbed(regs, interaction.guild?.name || null);
            if (interaction.message?.embeds?.length) await interaction.update({ embeds: [embed], components: buildListComponents() });
            else await interaction.reply({ content: want ? '✅ Je staat nu op **Aanwezig**.' : '❌ Je staat nu op **Niet aanwezig**.', ephemeral: true });
          } catch {
            await interaction.reply({ content: want ? '✅ Aanwezig.' : '❌ Niet aanwezig.', ephemeral: true }).catch(() => {});
          }
          return;
        }
      }
    } catch (e) {
      console.error('[bot] interaction error:', e);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Er ging iets mis. Probeer opnieuw.', ephemeral: true }); else await interaction.editReply({ content: 'Er ging iets mis.' }); } catch {}
    }
  });

  client.on(Events.Error, e => console.error('[bot] client error', e.message));
  await client.login(TOKEN);
  return client;
}

module.exports = { start, buildListEmbed, updateListChannel };

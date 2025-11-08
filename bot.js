// gamerpowe r-bot-with-resend.js
// Requires: discord.js@14.24.2, axios, node-cron, dotenv
// npm i discord.js@14.24.2 axios node-cron dotenv

const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  PermissionsBitField, 
  ChannelType,
  REST,
  Routes 
} = require('discord.js');

const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ----- Config -----
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // REQUIRED for registering per-guild commands
const GLOBAL_FALLBACK_CHANNEL = process.env.CHANNEL_ID || null; // optional fallback
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/30 * * * *';
const PLATFORM = process.env.PLATFORM || 'pc';
const TYPE = process.env.TYPE || 'game';

if (!TOKEN) {
  console.error('BOT_TOKEN is not set in .env');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.warn('CLIENT_ID not set. Slash commands may not register per-guild automatically.');
}

// ----- Persistence files -----
const STORE_FILE = path.resolve(__dirname, 'gamerpower_posted.json');         // posted ids
const MAP_FILE = path.resolve(__dirname, 'guild_channel_map.json');         // guild -> channel
const OFFERS_CACHE_FILE = path.resolve(__dirname, 'offers_cache.json');     // recent offers cache

// posted store
let store = { postedIds: [] };
try { if (fs.existsSync(STORE_FILE)) store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { console.warn('Could not read store file:', e.message || e); }
function saveStore() { try { fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2)); } catch (e) { console.error('Failed to save store file:', e.message || e); } }
function alreadyPosted(id) { return store.postedIds.includes(id); }
function markPosted(id) { store.postedIds.push(id); if (store.postedIds.length > 5000) store.postedIds = store.postedIds.slice(-3000); saveStore(); }

// guild -> channel mapping
let guildChannelMap = {};
try { if (fs.existsSync(MAP_FILE)) guildChannelMap = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch (e) { console.warn('Could not read guild channel map:', e.message || e); }
function saveMap() { try { fs.writeFileSync(MAP_FILE, JSON.stringify(guildChannelMap, null, 2)); } catch (e) { console.error('Failed to save guild map:', e.message || e); } }

// offers cache (id -> offer)
let offersCache = { byId: {}, recent: [] }; // recent is array of ids in order newest->oldest
try { if (fs.existsSync(OFFERS_CACHE_FILE)) offersCache = JSON.parse(fs.readFileSync(OFFERS_CACHE_FILE, 'utf8')); } catch (e) { console.warn('Could not read offers cache, starting empty:', e.message || e); }
function saveOffersCache() { try { fs.writeFileSync(OFFERS_CACHE_FILE, JSON.stringify(offersCache, null, 2)); } catch (e) { console.error('Failed to save offers cache:', e.message || e); } }
function cacheOffers(offers) {
  // offers: array of normalized offer objects with id/title/url/thumbnail/description/etc.
  for (const o of offers) {
    offersCache.byId[o.id] = o;
    // push to recent front, but avoid duplicates
    offersCache.recent = [o.id].concat(offersCache.recent.filter(x => x !== o.id));
  }
  // trim recent
  if (offersCache.recent.length > 1000) offersCache.recent = offersCache.recent.slice(0, 500);
  saveOffersCache();
}

// ----- GamerPower fetcher -----
const GAMERPOWER_BASE = 'https://gamerpower.com/api';

async function fetchGamerPowerGiveaways({ platform = PLATFORM, type = TYPE } = {}) {
  const url = `${GAMERPOWER_BASE}/giveaways`;
  const params = {};
  if (platform) params.platform = platform;
  if (type) params.type = type;

  try {
    const resp = await axios.get(url, {
      params,
      headers: { 'User-Agent': 'GamerPower-Discord-Bot/1.0', 'Accept': 'application/json' },
      timeout: 20000
    });
    if (!Array.isArray(resp.data)) return [];
    // Normalize items and attempt to extract platform from title if platforms missing
    const mapped = resp.data.map(item => {
      // attempt to pick platform from fields or from the title "(Platform)"
      let platformGuess = 'Unknown';
      const match = item.title?.match(/\(([^)]+)\)/);
      if (match && match[1]) platformGuess = match[1].trim();
      const platformField = item.platforms || item.platform || platformGuess;

      // Optionally remove trailing "(Platform)" from title for cleaner display:
      let titleClean = item.title || 'Unknown Giveaway';
      titleClean = titleClean.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

      return {
        id: item.id ? `gamerpower_${item.id}` : `gamerpower_${Buffer.from(titleClean + (item.open_giveaway_url||'')).toString('base64').slice(0,12)}`,
        title: titleClean,
        url: item.open_giveaway_url || item.url || null,
        thumbnail: item.image || null,
        description: (item.description || item.instructions || '').slice(0, 800),
        platform: platformField,
        type: item.type || null,
        worth: item.worth || null,
        expiresAt: item.end_date || null,
        raw: item
      };
    });

    return mapped;
  } catch (err) {
    if (err.response) {
      console.error('GamerPower API error:', err.response.status, err.response.statusText);
    } else {
      console.error('GamerPower fetch error:', err.message || err);
    }
    return [];
  }
}

// ----- Discord client -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// helper: build embed
function buildOfferEmbed(offer) {
  const embed = new EmbedBuilder()
    .setTitle(offer.title)
    .setURL(offer.url || undefined)
    .setDescription(offer.description || 'Free giveaway!')
    .addFields(
      { name: 'Platform', value: offer.platform || 'Unknown', inline: true },
      ...(offer.worth ? [{ name: 'Value', value: String(offer.worth), inline: true }] : []),
    )
    .setFooter({ text: 'Source: GamerPower' })
    .setTimestamp(new Date());
  if (offer.thumbnail) embed.setThumbnail(offer.thumbnail);
  if (offer.expiresAt) {
    const d = new Date(offer.expiresAt);
    if (!isNaN(d)) embed.addFields({ name: 'Ends', value: `<t:${Math.floor(d.getTime()/1000)}:R>`, inline: true });
  }
  return embed;
}

// Robust post helper (reuses from previous guidance)
async function postOfferToChannelObj(channelId, offer) {
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) {
      console.error(`[POST] Channel not found: ${channelId}`);
      return { ok: false, reason: 'channel_not_found' };
    }
    if (!(ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement || ch.isTextBased())) {
      console.warn(`[POST] Channel ${channelId} is not a text-based channel (type=${ch.type}).`);
      return { ok: false, reason: 'not_text_channel', channelType: ch.type };
    }

    const botMember = ch.guild?.members?.me || client.user;
    const perms = ch.permissionsFor(botMember);
    if (!perms) console.warn(`[POST] Could not resolve permissions for bot in channel ${channelId}.`);
    else {
      const needed = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages];
      const missing = needed.filter(p => !perms.has(p));
      if (missing.length > 0) {
        console.error(`[POST] Missing required perms in ${channelId}: ${missing.join(', ')}`);
        return { ok: false, reason: 'missing_permissions', missing };
      }
      if (!perms.has(PermissionsBitField.Flags.EmbedLinks)) {
        console.warn('[POST] Bot does not have Embed Links permission — embed may appear limited.');
      }
    }

    const embed = buildOfferEmbed(offer);

    let sentMessage;
    try {
      sentMessage = await ch.send({ embeds: [embed] });
      console.log(`[POST] Sent OK: message id ${sentMessage.id} to ${ch.guild?.name || 'unknown'}/${ch.id}`);
      return { ok: true, message: sentMessage };
    } catch (sendErr) {
      console.error('[POST] Send failed:', sendErr);
      return { ok: false, reason: 'send_failed', error: sendErr };
    }
  } catch (outerErr) {
    console.error('[POST] Unexpected error in postOfferToChannelObj:', outerErr);
    return { ok: false, reason: 'exception', error: outerErr };
  }
}

// Main check & post: posts per mapped guild channels; falls back to GLOBAL_FALLBACK_CHANNEL if present
async function checkAndPost() {
  console.log(new Date().toISOString(), 'Checking GamerPower for giveaways...');
  const offers = await fetchGamerPowerGiveaways();
  if (!offers || offers.length === 0) {
    console.log('No offers found.');
    return;
  }

  // cache offers for possible resend
  cacheOffers(offers);

  const newOffers = offers.filter(o => !alreadyPosted(o.id));
  if (newOffers.length === 0) {
    console.log('No new giveaways to post.');
    return;
  }
  console.log(`Found ${offers.length} offers, ${newOffers.length} new.`);

  const guildEntries = Object.entries(guildChannelMap);
  if (guildEntries.length > 0) {
    for (const [guildId, channelId] of guildEntries) {
      try {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) {
          console.warn(`Configured channel ${channelId} for guild ${guildId} not accessible or not a text channel.`);
          continue;
        }
        for (const offer of newOffers) {
          const ok = await postOfferToChannelObj(channelId, offer);
          if (ok.ok) markPosted(offer.id);
          await new Promise(r => setTimeout(r, 800));
        }
      } catch (e) {
        console.warn('Posting error for guild', guildId, e.message || e);
      }
    }
  } else if (GLOBAL_FALLBACK_CHANNEL) {
    const ch = await client.channels.fetch(GLOBAL_FALLBACK_CHANNEL).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) {
      console.error('Fallback CHANNEL_ID not found or not a text channel:', GLOBAL_FALLBACK_CHANNEL);
      return;
    }
    for (const offer of newOffers) {
      const ok = await postOfferToChannelObj(GLOBAL_FALLBACK_CHANNEL, offer);
      if (ok.ok) markPosted(offer.id);
      await new Promise(r => setTimeout(r, 800));
    }
  } else {
    console.warn('No channels configured (no guild mappings and no CHANNEL_ID fallback). Skipping posting.');
  }
}

// ----- Slash command definitions (added resend + list commands) -----
const setupCommands = [
  {
    name: 'set_giveaway_channel',
    description: 'Set the channel where giveaway notifications will be posted for this server',
    options: [
      { name: 'channel', description: 'Text channel to post giveaways into', type: 7, required: true } // 7 = CHANNEL
    ]
  },
  {
    name: 'view_giveaway_channel',
    description: 'Show current giveaway channel for this server'
  },
  {
    name: 'clear_giveaway_channel',
    description: 'Clear the configured giveaway channel for this server'
  },
  // New: resend command
  {
    name: 'resend_giveaway',
    description: 'Resend a previously seen giveaway (by offer ID) to this server\'s configured giveaway channel',
    options: [
      { name: 'offer_id', description: 'Giveaway offer ID (use /list_recent_offers to find IDs)', type: 3, required: true } // 3 = STRING
    ]
  },
  // New: list recent offers
  {
    name: 'list_recent_offers',
    description: 'List recent giveaway IDs and titles so you can pick one to resend',
    options: [
      { name: 'count', description: 'How many recent offers to list (max 25)', type: 4, required: false } // 4 = INTEGER
    ]
  }
];

// Register slash commands per guild (fast propagation)
async function registerCommandsPerGuild() {
  if (!CLIENT_ID) return;
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await client.guilds.fetch();
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(CLIENT_ID, guild.id),
          { body: setupCommands }
        );
        console.log(`Registered commands for guild ${guild.name} (${guild.id})`);
      } catch (e) {
        console.warn(`Failed to register commands for guild ${guild.id}:`, e.message || e);
      }
    }
  } catch (err) {
    console.error('Failed to register commands per guild:', err.message || err);
  }
}

// Interaction handler for slash commands (including resend/list)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // permission helper: require ManageGuild or Administrator for sensitive commands
  const hasManage = interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)
    || interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);

  if (commandName === 'set_giveaway_channel') {
    if (!hasManage) {
      await interaction.reply({ content: 'You need Manage Server (or Administrator) to run this.', ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel('channel');
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
      return;
    }
    guildChannelMap[interaction.guildId] = channel.id;
    saveMap();
    await interaction.reply({ content: `Giveaway channel set to ${channel} (ID: ${channel.id}). I will post giveaways here.`, ephemeral: false });
    return;
  }

  if (commandName === 'view_giveaway_channel') {
    const channelId = guildChannelMap[interaction.guildId];
    if (!channelId) {
      if (GLOBAL_FALLBACK_CHANNEL) {
        const cb = await client.channels.fetch(GLOBAL_FALLBACK_CHANNEL).catch(() => null);
        await interaction.reply({ content: `No guild-specific channel set. Bot fallback channel is ${cb ? `<#${GLOBAL_FALLBACK_CHANNEL}>` : GLOBAL_FALLBACK_CHANNEL}`, ephemeral: true });
      } else {
        await interaction.reply({ content: 'No giveaway channel configured for this server.', ephemeral: true });
      }
      return;
    }
    await interaction.reply({ content: `Configured giveaway channel: <#${channelId}> (ID: ${channelId})`, ephemeral: true });
    return;
  }

  if (commandName === 'clear_giveaway_channel') {
    if (!hasManage) {
      await interaction.reply({ content: 'You need Manage Server (or Administrator) to run this.', ephemeral: true });
      return;
    }
    const existed = Boolean(guildChannelMap[interaction.guildId]);
    delete guildChannelMap[interaction.guildId];
    saveMap();
    await interaction.reply({ content: existed ? 'Giveaway channel mapping removed.' : 'No mapping existed for this server.', ephemeral: true });
    return;
  }

  if (commandName === 'list_recent_offers') {
    const count = Math.min(Math.max(interaction.options.getInteger('count') || 10, 1), 25);
    // gather recent ids from cache
    const ids = offersCache.recent.slice(0, count);
    if (!ids || ids.length === 0) {
      await interaction.reply({ content: 'No cached offers available yet. Wait for the bot to run a fetch.', ephemeral: true });
      return;
    }
    // build lines: id - title (platform)
    const lines = ids.map(id => {
      const o = offersCache.byId[id];
      if (!o) return `${id} - (missing data)`;
      return `${id} - ${o.title} (${o.platform || 'Unknown'})`;
    });
    // send ephemeral message (split if long)
    await interaction.reply({ content: `Recent offers:\n${lines.join('\n')}`, ephemeral: true });
    return;
  }

  if (commandName === 'resend_giveaway') {
    if (!hasManage) {
      await interaction.reply({ content: 'You need Manage Server (or Administrator) to run this command.', ephemeral: true });
      return;
    }
    const offerId = interaction.options.getString('offer_id').trim();
    const offer = offersCache.byId[offerId];
    if (!offer) {
      await interaction.reply({ content: `Offer ID not found in cache: ${offerId}. Use /list_recent_offers to see available IDs.`, ephemeral: true });
      return;
    }

    // Resolve target channel for this guild
    const channelId = guildChannelMap[interaction.guildId] || GLOBAL_FALLBACK_CHANNEL;
    if (!channelId) {
      await interaction.reply({ content: 'No target channel configured for this server and no fallback CHANNEL_ID set. Use /set_giveaway_channel first.', ephemeral: true });
      return;
    }

    // Attempt to post
    await interaction.deferReply({ ephemeral: true });
    const res = await postOfferToChannelObj(channelId, offer);
    if (!res.ok) {
      // give helpful error feedback
      let msg = `Failed to resend offer ${offerId} to <#${channelId}>. Reason: ${res.reason || 'unknown'}.`;
      if (res.missing) msg += ` Missing perms: ${res.missing.join(', ')}`;
      await interaction.editReply({ content: msg });
      return;
    }

    // Optionally mark posted (so it won't be re-posted automatically) — do it only if you want resend to count as posted
    markPosted(offer.id);

    await interaction.editReply({ content: `Offer ${offerId} resent to <#${channelId}> successfully.` });
    return;
  }

});

// ----- Bot lifecycle -----
client.once('ready', async () => {
  console.log('Logged in as', client.user.tag);

  // Register per-guild slash commands (immediate)
  if (CLIENT_ID) {
    await registerCommandsPerGuild();
  }

  // initial run + schedule
  await checkAndPost();
  cron.schedule(CRON_SCHEDULE, async () => {
    try { await checkAndPost(); } catch (e) { console.error('Scheduled check error:', e); }
  }, { timezone: 'UTC' });

  console.log('GamerPower notifier running. Use /set_giveaway_channel and /resend_giveaway as needed.');
});

client.on('error', (err) => {
  console.error('Discord client error:', err);
});

client.login(TOKEN).catch(err => {
  console.error('Failed to login:', err.message || err);
  process.exit(1);
});

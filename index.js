// index.js — Full bot: slash + prefix + music + economy + moderation + dashboard
// Requires (in package.json): discord.js, @discordjs/voice, play-dl, express, express-rate-limit, dotenv, pretty-ms, ffmpeg-static, opusscript (or @discordjs/opus)

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection } = require('@discordjs/voice');
const playdl = require('play-dl');
const express = require('express');
const rateLimit = require('express-rate-limit');
const prettyMs = require('pretty-ms');

// ---------- CONFIG / ENV ----------
const TOKEN = process.env.TOKEN || process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || undefined; // optional testing guild
const OWNER_ID = process.env.OWNER_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-me';

// Validate critical envs
if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error('Missing TOKEN, CLIENT_ID, or OWNER_ID in environment. Set them on Render / locally.');
  process.exit(1);
}

// ---------- FILES (root) ----------
const ROOT = process.cwd();
const ALLOWED_FILE = path.join(ROOT, 'allowedUsers.json');      // array
const MUSIC_FILE = path.join(ROOT, 'musicQueues.json');        // object keyed by guildId
const COMMANDS_FILE = path.join(ROOT, 'customCommands.json');  // custom text commands
const ECON_FILE = path.join(ROOT, 'economy.json');             // economy store
const XP_FILE = path.join(ROOT, 'xp.json');                    // xp store
const PREFIXES_FILE = path.join(ROOT, 'prefixes.json');        // per-user prefixes
const COMMANDS_LIST_FILE = path.join(ROOT, 'commandsList.json'); // friendly command list categories

function ensureFile(file, fallback) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback ?? {}, null, 2));
}
function readJson(file, fallback) {
  try {
    ensureFile(file, fallback);
    return JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  } catch (e) {
    console.error('readJson error', file, e);
    return fallback ?? {};
  }
}
function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('writeJson error', file, e);
  }
}

// ensure data files exist
ensureFile(ALLOWED_FILE, [OWNER_ID]);
ensureFile(MUSIC_FILE, {});
ensureFile(COMMANDS_FILE, {});
ensureFile(ECON_FILE, {});
ensureFile(XP_FILE, {});
ensureFile(PREFIXES_FILE, {});
ensureFile(COMMANDS_LIST_FILE, {
  "Utility": { "ping": "Replies with bot latency", "hi": "Greets you", "help": "Shows help" },
  "Fun": { "meme": "Gives a meme (via external API)", "8ball": "Ask a question" },
  "Economy": { "balance": "Check balance", "daily": "Claim daily coins" },
  "Moderation": { "kick": "Kick a user (role-bound)", "ban": "Ban a user (role-bound)" },
  "Owner": { "addcommand": "Add custom command", "removecommand": "Remove custom command" }
});

// ---------- In-memory stores (load from files) ----------
let allowedUsers = new Set(readJson(ALLOWED_FILE, [OWNER_ID]));
let musicQueues = readJson(MUSIC_FILE, {});
let customCommands = readJson(COMMANDS_FILE, {});
let economy = readJson(ECON_FILE, {});
let xp = readJson(XP_FILE, {});
let prefixes = readJson(PREFIXES_FILE, {});
let commandsList = readJson(COMMANDS_LIST_FILE, {});

// helper to persist core stores periodically
function saveAll() {
  writeJson(ALLOWED_FILE, [...allowedUsers]);
  writeJson(MUSIC_FILE, musicQueues);
  writeJson(COMMANDS_FILE, customCommands);
  writeJson(ECON_FILE, economy);
  writeJson(XP_FILE, xp);
  writeJson(PREFIXES_FILE, prefixes);
  writeJson(COMMANDS_LIST_FILE, commandsList);
}
setInterval(saveAll, 30_000);

// ---------- UTILITY helpers ----------
const EPHEMERAL_FLAGS = 1 << 6; // 64
function ensureEconomy(uid) { if (!economy[uid]) economy[uid] = { balance: 0, lastDaily: 0 }; }
function ensureXP(uid) { if (!xp[uid]) xp[uid] = { xp: 0, level: 0, lastMessage: 0 }; }
function getPrefix(uid) { return prefixes[uid] || '`'; }
function addXPForMessage(uid) {
  ensureXP(uid);
  const now = Date.now();
  if (now - (xp[uid].lastMessage || 0) < 30_000) return false;
  xp[uid].lastMessage = now;
  const gained = Math.floor(Math.random()*6) + 5;
  xp[uid].xp += gained;
  const need = (xp[uid].level + 1) * 100;
  if (xp[uid].xp >= need) {
    xp[uid].xp -= need;
    xp[uid].level += 1;
    writeJson(XP_FILE, xp);
    return true;
  }
  writeJson(XP_FILE, xp);
  return false;
}

// cooldown map
const cooldowns = new Map();
function isOnCooldown(key, uid, ms=1000) {
  if (!cooldowns.has(key)) cooldowns.set(key, new Map());
  const m = cooldowns.get(key);
  const last = m.get(uid) || 0;
  if (Date.now() - last < ms) return true;
  m.set(uid, Date.now());
  setTimeout(()=>m.delete(uid), ms+1000);
  return false;
}

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});
const rest = new REST({ version: '10' }).setToken(TOKEN);

// ---------- Music player state ----------
const players = new Map(); // guildId -> AudioPlayer
const paused = new Map();  // guildId -> boolean

async function ensureQueue(guildId) {
  if (!musicQueues[guildId]) musicQueues[guildId] = { queue: [], playing: false, nowPlaying: null, playCount: 0 };
}

// robust playNext uses play-dl stream
async function playNext(guildId) {
  await ensureQueue(guildId);
  const q = musicQueues[guildId];
  if (!q.queue.length) {
    q.playing = false;
    q.nowPlaying = null;
    writeJson(MUSIC_FILE, musicQueues);
    return;
  }

  const item = q.queue.shift();
  const conn = getVoiceConnection(guildId);
  if (!conn) {
    // put back and stop playing
    q.queue.unshift(item);
    q.playing = false;
    writeJson(MUSIC_FILE, musicQueues);
    return;
  }

  // obtain stream — many sources handled
  let streamData;
  try {
    // play-dl can accept a URL or provide via video_info/search
    streamData = await playdl.stream(item.url).catch(()=>null);
    if (!streamData) {
      // try searching if url/stream failed
      const search = await playdl.search(item.title || item.url, { limit: 1 }).catch(()=>null);
      if (search && search.length) streamData = await playdl.stream(search[0].url).catch(()=>null);
    }
    if (!streamData) {
      // skip to next if we couldn't get audio
      return playNext(guildId);
    }
  } catch (err) {
    console.error('playNext stream error', err);
    return playNext(guildId);
  }

  const resource = createAudioResource(streamData.stream, { inputType: streamData.type });
  let player = players.get(guildId);
  if (!player) {
    player = createAudioPlayer();
    players.set(guildId, player);
    player.on(AudioPlayerStatus.Idle, () => { setTimeout(()=>playNext(guildId), 250); });
    player.on('error', (e) => { console.error('Audio player error', e); setTimeout(()=>playNext(guildId), 250); });
  }

  player.play(resource);
  conn.subscribe(player);

  q.playing = true;
  q.nowPlaying = {
    title: item.title,
    url: item.url,
    requestedBy: item.requestedBy || 'unknown',
    startedAt: Date.now(),
    duration: streamData.video_details?.durationInSec || 0
  };
  q.playCount = (q.playCount || 0) + 1;
  writeJson(MUSIC_FILE, musicQueues);
}

// ---------- Build slash commands ----------
function buildSlashCommands() {
  const base = [
    new SlashCommandBuilder().setName('help').setDescription('Show help & invite'),
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
    new SlashCommandBuilder().setName('hi').setDescription('Say hi back'),
    new SlashCommandBuilder().setName('about').setDescription('About the bot'),
    new SlashCommandBuilder().setName('commands').setDescription('List command categories'),
    // economy
    new SlashCommandBuilder().setName('balance').setDescription('Show your balance'),
    new SlashCommandBuilder().setName('daily').setDescription('Claim daily reward'),
    // moderation/owner
    new SlashCommandBuilder().setName('allow').setDescription('Allow a user (owner)').addUserOption(o=>o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('remove').setDescription('Remove allowed user (owner)').addUserOption(o=>o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('allowed').setDescription('List allowed users (owner only)'),
    // custom commands
    new SlashCommandBuilder().setName('addcommand').setDescription('Add custom command (owner)').addStringOption(o=>o.setName('name').setDescription('name').setRequired(true)).addStringOption(o=>o.setName('response').setDescription('response').setRequired(true)),
    new SlashCommandBuilder().setName('removecommand').setDescription('Remove custom command (owner)').addStringOption(o=>o.setName('name').setDescription('name').setRequired(true)),
    // music
    new SlashCommandBuilder().setName('play').setDescription('Play music (URL or search)').addStringOption(o=>o.setName('query').setDescription('URL or search query').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Skip track'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause/resume track'),
    new SlashCommandBuilder().setName('disconnect').setDescription('Disconnect bot from voice'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop playback & clear queue'),
    new SlashCommandBuilder().setName('queue').setDescription('Show queue'),
    new SlashCommandBuilder().setName('np').setDescription('Now playing'),
    new SlashCommandBuilder().setName('clearqueue').setDescription('Clear the queue'),
    new SlashCommandBuilder().setName('queueshift').setDescription('Move song in queue').addIntegerOption(o=>o.setName('from').setDescription('from (1-based)').setRequired(true)).addIntegerOption(o=>o.setName('to').setDescription('to (1-based)').setRequired(true))
  ];

  // add custom commands as simple slash commands if name valid
  for (const [name, resp] of Object.entries(customCommands || {})) {
    if (/^[\w-]{1,32}$/.test(name)) {
      try { base.push(new SlashCommandBuilder().setName(name).setDescription(String(resp).slice(0, 90))); } catch {}
    }
  }
  return base.map(c => c.toJSON());
}

// ---------- Register commands (global by default) ----------
async function registerAllCommands() {
  try {
    console.log('Registering slash commands...');
    const payload = buildSlashCommands();
    // if GUILD_ID set use guild commands (fast testing). Otherwise register global commands.
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: payload });
      console.log('Registered guild commands to', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: payload });
      console.log('Registered global commands (may take ~1 hour to propagate).');
    }
  } catch (err) {
    console.error('registerAllCommands error', err);
  }
}

// ---------- Interaction (slash) handler ----------
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    const uid = interaction.user.id;
    const isOwner = uid === OWNER_ID;

    // allow 'commands' publicly, otherwise enforce allowed list
    if (cmd !== 'commands' && !allowedUsers.has(uid) && !isOwner) {
      return interaction.reply({ content: '❌ You are not allowed to use this bot. Ask owner to /allow you.', flags: EPHEMERAL_FLAGS });
    }
    if (isOnCooldown(cmd, uid, 1200)) return interaction.reply({ content: '⏳ Slow down — you are using commands too quickly.', flags: EPHEMERAL_FLAGS });

    // basic utility
    if (cmd === 'help') return interaction.reply({ content: 'yooo, join up papi https://discord.gg/min', flags: EPHEMERAL_FLAGS });
    if (cmd === 'ping') return interaction.reply({ content: `🏓 Pong! WS ping: ${client.ws.ping}ms` });
    if (cmd === 'hi') return interaction.reply({ content: `${interaction.user} hi!` });
    if (cmd === 'about') return interaction.reply({ content: 'Modern multi-feature bot. Owner-run. Slash + prefix supported.' });

    if (cmd === 'commands') {
      // build embed from commandsList
      const embed = new EmbedBuilder().setTitle('📜 Commands').setColor(0x5865F2).setDescription('Slash & prefix commands');
      for (const [cat, entries] of Object.entries(commandsList || {})) {
        const lines = Object.entries(entries || {}).map(([n,d]) => `• \`/${n}\` — ${d}`).slice(0, 25);
        if (lines.length) embed.addFields({ name: cat, value: lines.join('\n').slice(0, 1024) });
      }
      const custom = Object.keys(customCommands || {});
      if (custom.length) embed.addFields({ name: 'Custom', value: custom.slice(0,50).map(c=>`• \`/${c}\``).join(', ').slice(0,1024) });
      return interaction.reply({ embeds: [embed], flags: EPHEMERAL_FLAGS });
    }

    // economy
    if (cmd === 'balance') { ensureEconomy(uid); return interaction.reply({ content: `💰 ${interaction.user.tag} — Balance: ${economy[uid].balance}` }); }
    if (cmd === 'daily') {
      ensureEconomy(uid);
      const now = Date.now(); const one = 24*60*60*1000; const last = economy[uid].lastDaily || 0;
      if (now - last < one) return interaction.reply({ content: `You already claimed daily. Try in ${prettyMs(one - (now-last))}.`, flags: EPHEMERAL_FLAGS });
      const amount = 100 + Math.floor(Math.random()*100);
      economy[uid].balance += amount; economy[uid].lastDaily = now; writeJson(ECON_FILE, economy);
      return interaction.reply({ content: `✅ You claimed ${amount} coins. Balance: ${economy[uid].balance}` });
    }

    // owner allow management
    if (cmd === 'allow') {
      if (!isOwner) return interaction.reply({ content: 'Owner only.', flags: EPHEMERAL_FLAGS });
      const u = interaction.options.getUser('user'); allowedUsers.add(u.id); writeJson(ALLOWED_FILE, [...allowedUsers]);
      return interaction.reply({ content: `✅ <@${u.id}> can now use the bot.`, flags: EPHEMERAL_FLAGS });
    }
    if (cmd === 'remove') {
      if (!isOwner) return interaction.reply({ content: 'Owner only.', flags: EPHEMERAL_FLAGS });
      const u = interaction.options.getUser('user'); allowedUsers.delete(u.id); writeJson(ALLOWED_FILE, [...allowedUsers]);
      return interaction.reply({ content: `✅ Removed <@${u.id}> from allowed users.`, flags: EPHEMERAL_FLAGS });
    }
    if (cmd === 'allowed') {
      if (!isOwner) return interaction.reply({ content: 'Owner only.', flags: EPHEMERAL_FLAGS });
      const list = [...allowedUsers].map(id=>`<@${id}>`).join('\n') || 'No allowed users set.';
      return interaction.reply({ content: `📜 Allowed users:\n${list}`, flags: EPHEMERAL_FLAGS });
    }

    // custom commands admin
    if (cmd === 'addcommand') {
      if (!isOwner) return interaction.reply({ content: 'Owner only.', flags: EPHEMERAL_FLAGS });
      const name = interaction.options.getString('name').toLowerCase(); const response = interaction.options.getString('response');
      if (!/^[\w-]{1,32}$/.test(name)) return interaction.reply({ content: 'Invalid name. Use letters/numbers/_/-, 1-32 chars.', flags: EPHEMERAL_FLAGS });
      customCommands[name] = response; writeJson(COMMANDS_FILE, customCommands); await registerAllCommands();
      return interaction.reply({ content: `✅ Added custom command /${name}`, flags: EPHEMERAL_FLAGS });
    }
    if (cmd === 'removecommand') {
      if (!isOwner) return interaction.reply({ content: 'Owner only.', flags: EPHEMERAL_FLAGS });
      const name = interaction.options.getString('name').toLowerCase();
      if (!customCommands[name]) return interaction.reply({ content: `Not found.`, flags: EPHEMERAL_FLAGS });
      delete customCommands[name]; writeJson(COMMANDS_FILE, customCommands); await registerAllCommands();
      return interaction.reply({ content: `✅ Removed /${name}`, flags: EPHEMERAL_FLAGS });
    }

    // moderation & music are next...
    // MUSIC: play/skip/pause/disconnect/stop/queue/np/clearqueue/queueshift
    if (['play','skip','pause','disconnect','stop','queue','np','clearqueue','queueshift'].includes(cmd)) {
      // ensure guild
      if (!interaction.guild) return interaction.reply({ content: 'This command must be run in a server.', flags: EPHEMERAL_FLAGS });

      await ensureQueue(interaction.guildId);
      const q = musicQueues[interaction.guildId];

      // /play
      if (cmd === 'play') {
        const query = interaction.options.getString('query');
        const member = interaction.member;
        if (!member || !member.voice?.channel) return interaction.reply({ content: 'You must be in a voice channel to use music.', flags: EPHEMERAL_FLAGS });

        // Resolve info robustly
        let song = null;
        try {
          // YouTube URL
          if (playdl.yt_validate(query) === 'video') {
            const info = await playdl.video_info(query);
            const title = info?.video_details?.title || info?.title || query;
            const url = info?.video_details?.url || query;
            song = { title, url, requestedBy: interaction.user.tag };
          } else if (playdl.sp_validate && (await playdl.sp_validate(query))) {
            // Spotify — play-dl supports extracting track(s)
            const sp = await playdl.spotify(query).catch(()=>null);
            if (sp && sp.name) song = { title: sp.name, url: query, requestedBy: interaction.user.tag };
          } else {
            // fallback: search YouTube
            const search = await playdl.search(query, { limit: 1 }).catch(()=>[]);
            if (search && search.length) song = { title: search[0].title || search[0].name, url: search[0].url, requestedBy: interaction.user.tag };
          }
        } catch (e) {
          console.error('/play lookup error', e);
        }

        if (!song) return interaction.reply({ content: '❌ Could not find that song.', flags: EPHEMERAL_FLAGS });
        q.queue.push(song);
        writeJson(MUSIC_FILE, musicQueues);

        // join voice if not connected
        if (!getVoiceConnection(interaction.guildId)) {
          try {
            joinVoiceChannel({ channelId: interaction.member.voice.channel.id, guildId: interaction.guildId, adapterCreator: interaction.guild.voiceAdapterCreator });
          } catch(e) { console.error('join voice error', e); }
        }

        if (!q.playing) setTimeout(()=>playNext(interaction.guildId), 900);
        return interaction.reply({ content: `✅ Queued: **${song.title}**` });
      }

      // /skip
      if (cmd === 'skip') {
        const player = players.get(interaction.guildId);
        if (!player) return interaction.reply({ content: 'Nothing playing.', flags: EPHEMERAL_FLAGS });
        player.stop();
        return interaction.reply({ content: '⏭ Skipped.' });
      }

      // /pause (toggle)
      if (cmd === 'pause') {
        const player = players.get(interaction.guildId);
        if (!player) return interaction.reply({ content: 'Nothing playing.', flags: EPHEMERAL_FLAGS });
        const isPaused = paused.get(interaction.guildId) || false;
        if (isPaused) { player.unpause(); paused.set(interaction.guildId, false); return interaction.reply({ content: '▶️ Resumed.' }); }
        else { player.pause(); paused.set(interaction.guildId, true); return interaction.reply({ content: '⏸️ Paused.' }); }
      }

      // /disconnect
      if (cmd === 'disconnect') {
        const conn = getVoiceConnection(interaction.guildId);
        if (conn) conn.destroy();
        players.delete(interaction.guildId);
        q.playing = false; q.nowPlaying = null; writeJson(MUSIC_FILE, musicQueues);
        return interaction.reply({ content: '👋 Disconnected.' });
      }

      // /stop -> clear and disconnect
      if (cmd === 'stop') {
        const conn = getVoiceConnection(interaction.guildId);
        if (conn) conn.destroy();
        players.delete(interaction.guildId);
        musicQueues[interaction.guildId] = { queue: [], playing: false, nowPlaying: null, playCount: 0 };
        writeJson(MUSIC_FILE, musicQueues);
        return interaction.reply({ content: '⏹ Stopped and cleared queue.' });
      }

      // /clearqueue
      if (cmd === 'clearqueue') {
        q.queue = []; writeJson(MUSIC_FILE, musicQueues);
        return interaction.reply({ content: '🧹 Cleared the queue.' });
      }

      // /queueshift from,to
      if (cmd === 'queueshift') {
        const from = (interaction.options.getInteger('from') || 1) - 1;
        const to = (interaction.options.getInteger('to') || 1) - 1;
        if (!q.queue || from < 0 || from >= q.queue.length || to < 0 || to > q.queue.length) {
          return interaction.reply({ content: '❌ Invalid indices.', flags: EPHEMERAL_FLAGS });
        }
        const [moved] = q.queue.splice(from,1);
        q.queue.splice(to,0,moved);
        writeJson(MUSIC_FILE, musicQueues);
        return interaction.reply({ content: `🔀 Moved **${moved.title}** to ${to+1}.` });
      }

      // /queue
      if (cmd === 'queue') {
        if (!q.queue || !q.queue.length) return interaction.reply({ content: '🎶 Queue is empty.', flags: EPHEMERAL_FLAGS });
        const list = q.queue.slice(0, 20).map((s,i)=>`${i+1}. ${s.title}`).join('\n');
        return interaction.reply({ content: `🎵 Queue:\n${list}` });
      }

      // /np
      if (cmd === 'np') {
        if (!q.nowPlaying) return interaction.reply({ content: '❌ Nothing is playing.', flags: EPHEMERAL_FLAGS });
        const cur = q.nowPlaying;
        const elapsed = Math.floor((Date.now() - (cur.startedAt||Date.now())) / 1000);
        const duration = cur.duration || 0;
        const progress = duration > 0 ? Math.min(elapsed/duration, 1) : 0;
        const bar = '▰'.repeat(Math.floor(progress*20)) + '▱'.repeat(20 - Math.floor(progress*20));
        const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
        const embed = new EmbedBuilder()
          .setTitle('🎶 Now Playing')
          .setDescription(`[${cur.title}](${cur.url})`)
          .addFields(
            { name: 'Progress', value: bar },
            { name: 'Time', value: `\`${fmt(elapsed)} / ${fmt(duration)}\`` }
          )
          .setFooter({ text: `Requested by ${cur.requestedBy}` })
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }
    }

    // custom runtime commands handling
    if (customCommands[cmd]) {
      return interaction.reply({ content: String(customCommands[cmd]).slice(0,1900) });
    }

    // If we reach here, not implemented
    return interaction.reply({ content: 'Unknown command or not implemented.', flags: EPHEMERAL_FLAGS });

  } catch (err) {
    console.error('interaction handler error', err);
    if (!interaction.replied) {
      try { interaction.reply({ content: 'An error occurred.', flags: EPHEMERAL_FLAGS }); } catch {}
    }
  }
});

// ---------- Prefix command support (user-specific prefix) ----------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    // autorespond / xp for messages
    if (addXPForMessage(message.author.id)) { message.channel?.send(`${message.author}, you leveled up! 🎉`).catch(()=>{}); }

    const pref = getPrefix(message.author.id);
    if (!message.content.startsWith(pref)) return;
    const body = message.content.slice(pref.length).trim();
    if (!body) return;
    const parts = body.split(/\s+/);
    const invoked = parts.shift().toLowerCase();

    if (invoked !== 'commands' && !allowedUsers.has(message.author.id) && message.author.id !== OWNER_ID) {
      return message.reply('❌ You are not allowed to use this bot. Ask owner to /allow you.').catch(()=>{});
    }
    if (isOnCooldown(`prefix_${invoked}`, message.author.id, 800)) return message.reply('⏳ Slow down.').catch(()=>{});

    // simple prefix commands mirror slash ones
    if (invoked === 'ping') return message.reply(`🏓 Pong! ${client.ws.ping}ms`).catch(()=>{});
    if (invoked === 'hi') return message.reply(`${message.author} hi!`).catch(()=>{});
    if (invoked === 'help') return message.reply('yooo, join up papi https://discord.gg/min').catch(()=>{});
    if (invoked === 'balance') { ensureEconomy(message.author.id); return message.reply(`💰 ${message.author.tag} — ${economy[message.author.id]?.balance || 0}`).catch(()=>{}); }
    if (invoked === 'daily') {
      ensureEconomy(message.author.id);
      const now = Date.now(); const one = 24*60*60*1000; const last = economy[message.author.id].lastDaily || 0;
      if (now - last < one) return message.reply(`You already claimed daily. Try in ${prettyMs(one - (now-last))}`).catch(()=>{});
      const amount = 100 + Math.floor(Math.random()*100); economy[message.author.id].balance += amount; economy[message.author.id].lastDaily = now; writeJson(ECON_FILE, economy);
      return message.reply(`✅ You claimed ${amount} coins!`).catch(()=>{});
    }

    // custom prefix commands
    if (customCommands[invoked]) return message.reply(String(customCommands[invoked]).slice(0,1900)).catch(()=>{});

    // music prefix variants: play <query>
    if (invoked === 'play') {
      const query = parts.join(' ');
      if (!message.member?.voice?.channel) return message.reply('Join voice channel first.').catch(()=>{});
      await ensureQueue(message.guildId);
      // quick search fallback similar to slash logic
      let song = null;
      try {
        if (playdl.yt_validate(query) === 'video') {
          const info = await playdl.video_info(query);
          song = { title: info?.video_details?.title || query, url: info?.video_details?.url || query, requestedBy: message.author.tag };
        } else {
          const search = await playdl.search(query, { limit: 1 }).catch(()=>[]);
          if (search && search.length) song = { title: search[0].title || search[0].name, url: search[0].url, requestedBy: message.author.tag };
        }
      } catch(e) { console.error('prefix play error', e); }

      if (!song) return message.reply('❌ Could not find that song.').catch(()=>{});
      musicQueues[message.guildId].queue.push(song); writeJson(MUSIC_FILE, musicQueues);
      try { joinVoiceChannel({ channelId: message.member.voice.channel.id, guildId: message.guildId, adapterCreator: message.guild.voiceAdapterCreator }); } catch(e){}
      if (!musicQueues[message.guildId].playing) setTimeout(()=>playNext(message.guildId), 900);
      return message.reply(`✅ Queued: ${song.title}`).catch(()=>{});
    }

    // fallback
    return message.reply('Unknown command.').catch(()=>{});

  } catch (e) { console.error('message handler error', e); }
});

// ---------- Dashboard & keep-alive ----------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('trust proxy', true);
const dashLimiter = rateLimit({ windowMs: 60_000, max: 12, standardHeaders: true });
app.use('/dashboard', dashLimiter);

app.get('/', (req, res) => res.send('Bot is alive.'));
app.get('/dashboard', (req, res) => {
  res.send(`<html><body>
    <h2>Dashboard Login</h2>
    <form method="POST" action="/dashboard">
      <label>Password: <input name="pw" type="password"/></label>
      <button>Login</button>
    </form>
  </body></html>`);
});
app.post('/dashboard', (req, res) => {
  const pw = req.body.pw || req.body.password || '';
  console.log(`[dashboard] login attempt ip=${req.ip} pwlen=${pw.length}`);
  if (!DASHBOARD_PASSWORD) return res.status(500).send('Dashboard not configured.');
  if (pw !== DASHBOARD_PASSWORD) return res.status(401).send('Unauthorized');
  const guilds = client.guilds.cache.size;
  const users = client.users.cache.size;
  res.send(`<h1>Dashboard</h1><p>Guilds: ${guilds}</p><p>Users cached: ${users}</p><p>Uptime: ${prettyMs(process.uptime()*1000)}</p>`);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Dashboard listening on ${PORT}`));

// ---------- Startup ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // ensure owner in allowed
  allowedUsers.add(OWNER_ID);
  writeJson(ALLOWED_FILE, [...allowedUsers]);
  // register commands (global or guild)
  await registerAllCommands();

  // presence rotation
  const activityTypes = [0,2,3,5];
  const statuses = ['online','idle','dnd'];
  let i = Math.floor(Math.random()*activityTypes.length);
  const updatePresence = () => {
    const activity = activityTypes[i % activityTypes.length];
    const status = statuses[Math.floor(Math.random()*statuses.length)];
    client.user.setPresence({ activities: [{ name: 'at /min', type: activity }], status });
    i++;
  };
  updatePresence();
  setInterval(updatePresence, 60_000);
});

// login
client.login(TOKEN);

// global error handlers
process.on('unhandledRejection', e => console.error('UnhandledRejection', e));
process.on('uncaughtException', e => console.error('UncaughtException', e));
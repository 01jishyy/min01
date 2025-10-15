// index.js — Modern Discord bot (Slash + Prefix + Music, Render compatible, safe)
// Features: Economy, XP, Music (Spotify/SoundCloud/YouTube), Dashboard, Custom Commands

const {
  Client, GatewayIntentBits, Partials,
  REST, Routes, SlashCommandBuilder
} = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const ms = require('ms');
const prettyMs = require('pretty-ms');
const rateLimit = require('express-rate-limit');
const playdl = require('play-dl');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, getVoiceConnection
} = require('@discordjs/voice');

require('dotenv').config();

// ---------- CONFIG ----------
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'defaultpassword';

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error("❌ Missing BOT_TOKEN, CLIENT_ID or OWNER_ID. Add them in Render Environment.");
  process.exit(1);
}

// ---------- FILE SETUP ----------
const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback ?? {}, null, 2));
    return JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  } catch {
    return fallback ?? {};
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const FILES = {
  commands: path.join(DATA_DIR, 'commands.json'),
  allowed: path.join(DATA_DIR, 'allowed.json'),
  prefixes: path.join(DATA_DIR, 'prefixes.json'),
  economy: path.join(DATA_DIR, 'economy.json'),
  xp: path.join(DATA_DIR, 'xp.json'),
  musicQueues: path.join(DATA_DIR, 'musicQueues.json')
};

let customCommands = readJson(FILES.commands, {});
let allowedUsers = new Set(readJson(FILES.allowed, [OWNER_ID]));
let prefixes = readJson(FILES.prefixes, {});
let economy = readJson(FILES.economy, {});
let xp = readJson(FILES.xp, {});
let musicQueues = readJson(FILES.musicQueues, {});

const saveAll = () => {
  writeJson(FILES.commands, customCommands);
  writeJson(FILES.allowed, [...allowedUsers]);
  writeJson(FILES.prefixes, prefixes);
  writeJson(FILES.economy, economy);
  writeJson(FILES.xp, xp);
  writeJson(FILES.musicQueues, musicQueues);
};

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});
const rest = new REST({ version: '10' }).setToken(TOKEN);

// ---------- COOLDOWNS ----------
const cooldowns = new Map();
function isOnCooldown(cmd, userId, cooldownMs = 2000) {
  const now = Date.now();
  if (!cooldowns.has(cmd)) cooldowns.set(cmd, new Map());
  const map = cooldowns.get(cmd);
  const last = map.get(userId) || 0;
  if (now - last < cooldownMs) return true;
  map.set(userId, now);
  setTimeout(() => map.delete(userId), cooldownMs + 1000);
  return false;
}

// ---------- XP SYSTEM ----------
function ensureXP(id) {
  if (!xp[id]) xp[id] = { xp: 0, level: 0, lastMessage: 0 };
}
function addXP(id) {
  ensureXP(id);
  const now = Date.now();
  if (now - xp[id].lastMessage < 30000) return false;
  xp[id].lastMessage = now;
  xp[id].xp += Math.floor(Math.random() * 6) + 5;
  const needed = (xp[id].level + 1) * 100;
  if (xp[id].xp >= needed) {
    xp[id].xp -= needed;
    xp[id].level += 1;
    writeJson(FILES.xp, xp);
    return true;
  }
  writeJson(FILES.xp, xp);
  return false;
}

// ---------- MUSIC ----------
async function ensureQueue(gid) {
  if (!musicQueues[gid]) musicQueues[gid] = { queue: [], playing: false };
}
async function playNext(gid) {
  await ensureQueue(gid);
  const q = musicQueues[gid];
  if (!q.queue.length) { q.playing = false; writeJson(FILES.musicQueues, musicQueues); return; }

  const item = q.queue.shift();
  const conn = getVoiceConnection(gid);
  if (!conn) { q.playing = false; return; }

  const stream = await playdl.stream(item.url).catch(() => null);
  if (!stream) return playNext(gid);

  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  const player = createAudioPlayer();
  conn.subscribe(player);

  player.play(resource);
  q.playing = true;
  player.on(AudioPlayerStatus.Idle, () => playNext(gid));
  player.on('error', err => { console.error('Music error', err); playNext(gid); });

  writeJson(FILES.musicQueues, musicQueues);
}

// ---------- SLASH COMMANDS ----------
function buildCommands() {
  const cmds = [
    new SlashCommandBuilder().setName('help').setDescription('Show help & invite link'),
    new SlashCommandBuilder().setName('ping').setDescription('Check latency'),
    new SlashCommandBuilder().setName('hi').setDescription('Say hi back'),
    new SlashCommandBuilder().setName('balance').setDescription('Show your balance'),
    new SlashCommandBuilder().setName('daily').setDescription('Claim daily reward'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Show top users'),
    new SlashCommandBuilder().setName('profile').setDescription('Show your stats'),
    new SlashCommandBuilder().setName('commands').setDescription('Show all commands'),
    // Music
    new SlashCommandBuilder().setName('play').setDescription('Play a song from YouTube/Spotify/SoundCloud').addStringOption(o => o.setName('query').setDescription('URL or search query').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop music and clear queue'),
    new SlashCommandBuilder().setName('queue').setDescription('View current queue'),
  ];
  return cmds.map(c => c.toJSON());
}

async function registerAll() {
  try {
    console.log('🔁 Registering commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: buildCommands() });
    console.log('✅ Commands registered.');
  } catch (err) {
    console.error('Register error:', err);
  }
}

// ---------- SLASH COMMAND HANDLER ----------
client.on('interactionCreate', async i => {
  try {
    if (!i.isChatInputCommand()) return;
    const cmd = i.commandName;
    const id = i.user.id;
    const isOwner = id === OWNER_ID;

    if (!allowedUsers.has(id) && cmd !== 'help') return i.reply({ content: '❌ Not allowed.', ephemeral: true });
    if (isOnCooldown(cmd, id, 1200)) return i.reply({ content: '⏳ Slow down!', ephemeral: true });

    if (cmd === 'help') return i.reply('yooo, join up papi https://discord.gg/min');
    if (cmd === 'ping') return i.reply(`🏓 Pong! ${client.ws.ping}ms`);
    if (cmd === 'hi') return i.reply(`${i.user} hi!`);

    // Economy
    if (cmd === 'balance') {
      if (!economy[id]) economy[id] = { balance: 0, lastDaily: 0 };
      return i.reply(`💰 ${i.user.tag}: ${economy[id].balance} coins`);
    }
    if (cmd === 'daily') {
      if (!economy[id]) economy[id] = { balance: 0, lastDaily: 0 };
      const now = Date.now();
      const left = 86400000 - (now - economy[id].lastDaily);
      if (left > 0) return i.reply(`⏰ Wait ${prettyMs(left)} to claim again.`);
      const amt = 100 + Math.floor(Math.random() * 100);
      economy[id].balance += amt;
      economy[id].lastDaily = now;
      writeJson(FILES.economy, economy);
      return i.reply(`✅ You got ${amt} coins!`);
    }
    if (cmd === 'leaderboard') {
      const arr = Object.entries(economy).map(([id, v]) => ({ id, bal: v.balance || 0 })).sort((a, b) => b.bal - a.bal).slice(0, 10);
      const txt = arr.map((a, i) => `${i + 1}. <@${a.id}> — ${a.bal}`).join('\n') || 'No data';
      return i.reply(`🏆 Leaderboard:\n${txt}`);
    }
    if (cmd === 'profile') {
      if (!xp[id]) xp[id] = { xp: 0, level: 0 };
      const bal = economy[id]?.balance || 0;
      const lev = xp[id].level;
      const xpval = xp[id].xp;
      return i.reply(`📊 ${i.user.tag}\n💰 Balance: ${bal}\n⭐ Level: ${lev}\nXP: ${xpval}`);
    }

    // Music
    if (cmd === 'play') {
      const query = i.options.getString('query');
      const member = i.member;
      if (!member.voice.channel) return i.reply({ content: 'Join a voice channel first.', ephemeral: true });
      await ensureQueue(i.guildId);

      let info;
      try {
        if (playdl.yt_validate(query) === 'video') info = await playdl.video_info(query);
        else {
          const search = await playdl.search(query, { limit: 1 });
          info = search?.[0];
        }
      } catch { info = null; }

      const url = info?.url || query;
      musicQueues[i.guildId].queue.push({ title: info?.title || query, url });
      writeJson(FILES.musicQueues, musicQueues);

      const conn = joinVoiceChannel({ channelId: member.voice.channel.id, guildId: i.guildId, adapterCreator: member.guild.voiceAdapterCreator });
      if (!musicQueues[i.guildId].playing) setTimeout(() => playNext(i.guildId), 1000);
      return i.reply(`🎵 Queued: **${info?.title || query}**`);
    }
    if (cmd === 'skip') {
      const conn = getVoiceConnection(i.guildId);
      if (!conn) return i.reply('❌ Nothing is playing.');
      conn.state.subscription.player.stop();
      return i.reply('⏭️ Skipped!');
    }
    if (cmd === 'stop') {
      const conn = getVoiceConnection(i.guildId);
      if (conn) conn.destroy();
      musicQueues[i.guildId] = { queue: [], playing: false };
      writeJson(FILES.musicQueues, musicQueues);
      return i.reply('⏹️ Stopped and cleared queue.');
    }
    if (cmd === 'queue') {
      await ensureQueue(i.guildId);
      const q = musicQueues[i.guildId];
      if (!q.queue.length) return i.reply('Queue is empty.');
      const list = q.queue.slice(0, 10).map((it, j) => `${j + 1}. ${it.title}`).join('\n');
      return i.reply(`🎶 Queue:\n${list}`);
    }

    if (cmd === 'commands') {
      return i.reply('📜 Commands: help, ping, hi, balance, daily, leaderboard, profile, play, skip, stop, queue');
    }

  } catch (err) {
    console.error('Interaction error', err);
    if (!i.replied) i.reply({ content: '⚠️ Error occurred.', ephemeral: true });
  }
});

// ---------- PREFIX COMMANDS ----------
client.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  const id = msg.author.id;
  const pref = prefixes[id] || '`';
  if (!msg.content.startsWith(pref)) {
    const leveled = addXP(id);
    if (leveled) msg.channel.send(`${msg.author} leveled up! 🎉`);
    return;
  }
  const args = msg.content.slice(pref.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  if (!cmd) return;
  if (!allowedUsers.has(id) && cmd !== 'help') return msg.reply('❌ Not allowed.');
  if (isOnCooldown(`p_${cmd}`, id, 1000)) return msg.reply('⏳ Slow down.');

  if (cmd === 'ping') return msg.reply(`🏓 Pong! ${client.ws.ping}ms`);
  if (cmd === 'hi') return msg.reply(`${msg.author} hi!`);
  if (cmd === 'help') return msg.reply('yooo, join up papi https://discord.gg/min');
  if (cmd === 'balance') return msg.reply(`💰 ${msg.author.tag}: ${economy[id]?.balance || 0}`);

  if (customCommands[cmd]) return msg.reply(customCommands[cmd].slice(0, 1900));
});

// ---------- DASHBOARD ----------
const app = express();
app.use(express.urlencoded({ extended: true }));
const dashLimiter = rateLimit({ windowMs: 60_000, max: 10 });
app.use('/dashboard', dashLimiter);
app.get('/', (req, res) => res.send('<h2>Bot is alive. Go to <a href="/dashboard">/dashboard</a></h2>'));
app.get('/dashboard', (req, res) => {
  res.send(`<html><body><form method="POST" action="/dashboard">
  <label>Password: <input name="pw" type="password"/></label>
  <button>Login</button></form></body></html>`);
});
app.post('/dashboard', (req, res) => {
  if (req.body.pw !== DASHBOARD_PASSWORD) return res.status(401).send('Unauthorized');
  res.send(`<h1>Dashboard</h1>
  <p>Guilds: ${client.guilds.cache.size}</p>
  <p>Users: ${client.users.cache.size}</p>
  <p>Uptime: ${prettyMs(process.uptime()*1000)}</p>`);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Dashboard on ${PORT}`));

// ---------- STARTUP ----------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  allowedUsers.add(OWNER_ID);
  writeJson(FILES.allowed, [...allowedUsers]);
  await registerAll();
});
setInterval(saveAll, 30000);
client.login(TOKEN);
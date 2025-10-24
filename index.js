// Modern Discord Bot w/ Music + Dashboard (Render Safe)
// Includes: /play, /skip, /pause, /disconnect, /clearqueue, /queueshift, /queue, /np
// Supports YouTube + SoundCloud (no cookie required)
// Author: you 👑

const {
  Client, GatewayIntentBits, Partials,
  REST, Routes, SlashCommandBuilder, Collection
} = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const ms = require('ms');
const prettyMs = require('pretty-ms');
const rateLimit = require('express-rate-limit');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection
} = require('@discordjs/voice');
const playdl = require('play-dl');

require('dotenv').config();

// ----------- ENV VARIABLES -----------
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'defaultpassword';
if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error("❌ Missing BOT_TOKEN, CLIENT_ID or OWNER_ID. Add them in Render Environment.");
  process.exit(1);
}

// ----------- FILE SETUP -----------
const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const MUSIC_FILE = path.join(DATA_DIR, 'musicQueues.json');
const ALLOWED_FILE = path.join(DATA_DIR, 'allowed.json');
if (!fs.existsSync(MUSIC_FILE)) fs.writeFileSync(MUSIC_FILE, JSON.stringify({}));
if (!fs.existsSync(ALLOWED_FILE)) fs.writeFileSync(ALLOWED_FILE, JSON.stringify([OWNER_ID]));

let musicQueues = JSON.parse(fs.readFileSync(MUSIC_FILE, 'utf8') || '{}');
let allowedUsers = new Set(JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf8') || '[]'));

function saveMusic() {
  fs.writeFileSync(MUSIC_FILE, JSON.stringify(musicQueues, null, 2));
}
function saveAllowed() {
  fs.writeFileSync(ALLOWED_FILE, JSON.stringify([...allowedUsers], null, 2));
}

// ----------- CLIENT SETUP -----------
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

// ----------- PLAY-DL INIT -----------
(async () => {
  try {
    await playdl.setToken({
      youtube: { cookie: process.env.YT_COOKIE || "" }
    });
    console.log("🎵 play-dl initialized (cookie present:", !!process.env.YT_COOKIE, ")");
  } catch (err) {
    console.warn("play-dl init warning:", err?.message || err);
  }
})();

// ----------- STATUS ROTATION -----------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  allowedUsers.add(OWNER_ID);
  saveAllowed();

  const activityTypes = [0, 2, 3, 5];
  const statuses = ['online', 'idle', 'dnd'];
  let i = 0;

  const updatePresence = () => {
    const activity = activityTypes[i % activityTypes.length];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    client.user.setPresence({
      activities: [{ name: 'at /min', type: activity }],
      status
    });
    console.log(`🌀 Presence updated: type=${activity}, status=${status}`);
    i++;
  };
  updatePresence();
  setInterval(updatePresence, 60000);

  await registerAll();
});

// ----------- QUEUE + PLAYER LOGIC -----------
const players = new Map();

async function ensureQueue(guildId) {
  if (!musicQueues[guildId]) musicQueues[guildId] = { queue: [], playing: false, nowPlaying: null };
}

async function playNext(guildId) {
  await ensureQueue(guildId);
  const q = musicQueues[guildId];
  if (!q.queue.length) {
    q.playing = false;
    q.nowPlaying = null;
    saveMusic();
    return;
  }

  const song = q.queue.shift();
  const conn = getVoiceConnection(guildId);
  if (!conn) return;

  try {
    const stream = await playdl.stream(song.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    const player = players.get(guildId) || createAudioPlayer();

    player.play(resource);
    conn.subscribe(player);

    q.playing = true;
    q.nowPlaying = { ...song, startedAt: Date.now(), duration: stream.video_details?.durationInSec || 0 };
    players.set(guildId, player);
    saveMusic();

    player.once(AudioPlayerStatus.Idle, () => playNext(guildId));
    player.once('error', err => {
      console.error('Player error:', err);
      playNext(guildId);
    });
  } catch (err) {
    console.error('playNext stream error:', err);
    playNext(guildId);
  }
}

// ----------- COMMAND REGISTRATION -----------
async function registerAll() {
  try {
    const cmds = [
      new SlashCommandBuilder().setName('play').setDescription('Play music').addStringOption(o => o.setName('query').setDescription('Song or link').setRequired(true)),
      new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
      new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
      new SlashCommandBuilder().setName('disconnect').setDescription('Disconnect the bot from voice'),
      new SlashCommandBuilder().setName('clearqueue').setDescription('Clear the queue'),
      new SlashCommandBuilder().setName('queueshift').setDescription('Move a song in the queue').addIntegerOption(o => o.setName('from').setDescription('Current position').setRequired(true)).addIntegerOption(o => o.setName('to').setDescription('New position').setRequired(true)),
      new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
      new SlashCommandBuilder().setName('np').setDescription('Show what’s currently playing')
    ].map(c => c.toJSON());

    console.log("🔁 Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("Slash register error:", err);
  }
}

// ----------- COMMAND HANDLER -----------
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  const cmd = i.commandName;
  const id = i.user.id;

  if (!allowedUsers.has(id) && !['play', 'queue', 'np', 'skip', 'pause', 'disconnect'].includes(cmd))
    return i.reply({ content: '❌ You are not allowed to use this bot.', ephemeral: true });

  try {
    if (cmd === 'play') {
      const query = i.options.getString('query');
      const member = i.member;
      if (!member.voice.channel) return i.reply({ content: 'Join a voice channel first.', ephemeral: true });

      await ensureQueue(i.guildId);
      let song = null;

      try {
        const ytCheck = playdl.yt_validate(query);
        if (ytCheck === 'video') {
          const info = await playdl.video_info(query);
          song = { title: info.video_details.title, url: info.video_details.url, requestedBy: i.user.tag };
        }
      } catch {}

      if (!song) {
        const search = await playdl.search(query, { limit: 1 }).catch(() => []);
        if (search[0]) {
          const it = search[0];
          const title = it.title ?? it.name;
          const url = it.url ?? it.link;
          song = { title: title || query, url, requestedBy: i.user.tag };
        }
      }

      if (!song) return i.reply({ content: '❌ Could not find that song.', ephemeral: true });

      musicQueues[i.guildId].queue.push(song);
      saveMusic();

      if (!getVoiceConnection(i.guildId)) {
        joinVoiceChannel({
          channelId: member.voice.channel.id,
          guildId: i.guildId,
          adapterCreator: member.guild.voiceAdapterCreator
        });
      }

      if (!musicQueues[i.guildId].playing) setTimeout(() => playNext(i.guildId), 1000);
      return i.reply(`✅ Queued: **${song.title}**`);
    }

    if (cmd === 'skip') {
      const p = players.get(i.guildId);
      if (!p) return i.reply('❌ Nothing is playing.');
      p.stop();
      return i.reply('⏭ Skipped.');
    }

    if (cmd === 'pause') {
      const p = players.get(i.guildId);
      if (!p) return i.reply('❌ Nothing is playing.');
      p.pause();
      return i.reply('⏸️ Paused.');
    }

    if (cmd === 'disconnect') {
      const conn = getVoiceConnection(i.guildId);
      if (!conn) return i.reply('❌ Not connected.');
      conn.destroy();
      musicQueues[i.guildId].playing = false;
      musicQueues[i.guildId].nowPlaying = null;
      saveMusic();
      return i.reply('👋 Disconnected.');
    }

    if (cmd === 'clearqueue') {
      await ensureQueue(i.guildId);
      musicQueues[i.guildId].queue = [];
      saveMusic();
      return i.reply('🧹 Queue cleared.');
    }

    if (cmd === 'queueshift') {
      const from = i.options.getInteger('from');
      const to = i.options.getInteger('to');
      const q = musicQueues[i.guildId]?.queue;
      if (!q || !q[from - 1]) return i.reply('Invalid positions.');
      const [moved] = q.splice(from - 1, 1);
      q.splice(to - 1, 0, moved);
      saveMusic();
      return i.reply(`🔀 Moved **${moved.title}** from position ${from} to ${to}.`);
    }

    if (cmd === 'queue') {
      const q = musicQueues[i.guildId];
      if (!q || !q.queue.length) return i.reply('🎶 Queue is empty.');
      const list = q.queue.slice(0, 10).map((s, idx) => `${idx + 1}. [${s.title}](${s.url})`).join('\n');
      return i.reply({ content: `🎵 **Queue:**\n${list}` });
    }

    if (cmd === 'np') {
      const q = musicQueues[i.guildId];
      if (!q || !q.nowPlaying) return i.reply('❌ Nothing is playing.');
      const c = q.nowPlaying;
      const elapsed = (Date.now() - c.startedAt) / 1000;
      const duration = c.duration || 0;
      const progress = Math.min(elapsed / duration, 1);
      const bar = '▰'.repeat(Math.floor(progress * 15)) + '▱'.repeat(15 - Math.floor(progress * 15));
      const fmt = s => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
      return i.reply({
        embeds: [{
          title: '🎶 Now Playing',
          description: `[${c.title}](${c.url})`,
          color: 0x5865F2,
          fields: [
            { name: 'Progress', value: bar },
            { name: 'Time', value: `\`${fmt(elapsed)} / ${fmt(duration)}\`` }
          ],
          footer: { text: `Requested by ${c.requestedBy}` }
        }]
      });
    }

  } catch (err) {
    console.error('Command error:', err);
    i.reply({ content: '⚠️ Error occurred.', ephemeral: true }).catch(() => {});
  }
});

// ----------- DASHBOARD + KEEPALIVE -----------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use('/dashboard', rateLimit({ windowMs: 60_000, max: 10 }));

app.get('/', (req, res) => res.send('<h2>Bot is alive. Go to <a href="/dashboard">/dashboard</a></h2>'));
app.get('/dashboard', (req, res) => {
  res.send(`
    <html><body>
      <form method="POST" action="/dashboard">
        <label>Password: <input name="pw" type="password"/></label>
        <button>Login</button>
      </form>
    </body></html>
  `);
});
app.post('/dashboard', (req, res) => {
  if (req.body.pw !== DASHBOARD_PASSWORD) return res.status(401).send('Unauthorized');
  const guilds = client.guilds.cache.size;
  const users = client.users.cache.size;
  res.send(`<h1>Dashboard</h1>
    <p>Guilds: ${guilds}</p>
    <p>Users: ${users}</p>
    <p>Uptime: ${prettyMs(process.uptime()*1000)}</p>
  `);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT}`));

client.login(TOKEN);
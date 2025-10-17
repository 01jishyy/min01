// index.js — Discord bot (status rotation + dashboard + music + queue management)

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder
} = require('discord.js');
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const prettyMs = require('pretty-ms');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection
} = require('@discordjs/voice');
const playdl = require('play-dl');
require('dotenv').config();

// --- ENVIRONMENT VARIABLES ---
const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
const OWNER_ID = process.env.OWNER_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'defaultpass';
if (!token || !clientId || !OWNER_ID) {
  console.error('❌ Missing TOKEN, CLIENT_ID, or OWNER_ID');
  process.exit(1);
}

// --- FILE SETUP ---
const ALLOWED_FILE = './allowedUsers.json';
const MUSIC_FILE = './musicQueues.json';
let allowedUsers = new Set();
let musicQueues = {};

try {
  const data = fs.readFileSync(ALLOWED_FILE, 'utf8');
  allowedUsers = new Set(JSON.parse(data));
} catch {
  console.log('✅ allowedUsers.json not found, creating new one.');
}

try {
  if (!fs.existsSync(MUSIC_FILE))
    fs.writeFileSync(MUSIC_FILE, JSON.stringify({}));
  musicQueues = JSON.parse(fs.readFileSync(MUSIC_FILE, 'utf8'));
} catch {
  musicQueues = {};
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- COMMAND REGISTRATION ---
const commands = [
  { name: 'min', description: 'Replies with Min' },
  { name: 'ping', description: 'Replies with Pong' },
  { name: 'help', description: 'Min help' },
  { name: 'play', description: 'Play music', options: [{ name: 'query', type: 3, description: 'URL or search', required: true }] },
  { name: 'skip', description: 'Skip current song' },
  { name: 'queue', description: 'Show the queue' },
  { name: 'np', description: 'Now playing' },
  { name: 'disconnect', description: 'Disconnect from voice channel' },
  { name: 'pause', description: 'Pause playback' },
  { name: 'clearqueue', description: 'Clear the entire queue' },
  {
    name: 'queueshift',
    description: 'Move a song in the queue',
    options: [
      { name: 'from', type: 4, description: 'Current position (1-based)', required: true },
      { name: 'to', type: 4, description: 'New position (1-based)', required: true }
    ]
  }
];

const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  try {
    console.log('🔁 Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('✅ Commands registered.');
  } catch (error) {
    console.error(error);
  }
})();

// --- CLIENT SETUP ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

const players = new Map();
const paused = new Map();

// --- MUSIC LOGIC ---
async function ensureQueue(guildId) {
  if (!musicQueues[guildId])
    musicQueues[guildId] = { queue: [], playing: false, nowPlaying: null };
}

async function playNext(guildId) {
  await ensureQueue(guildId);
  const q = musicQueues[guildId];
  if (!q.queue.length) {
    q.playing = false;
    q.nowPlaying = null;
    writeJson(MUSIC_FILE, musicQueues);
    return;
  }

  const song = q.queue.shift();
  const conn = getVoiceConnection(guildId);
  if (!conn) return;

  const stream = await playdl.stream(song.url);
  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  const player = players.get(guildId) || createAudioPlayer();

  player.play(resource);
  conn.subscribe(player);

  q.playing = true;
  q.nowPlaying = {
    ...song,
    startedAt: Date.now(),
    duration: stream.video_details?.durationInSec || 0
  };
  players.set(guildId, player);
  writeJson(MUSIC_FILE, musicQueues);

  player.once(AudioPlayerStatus.Idle, () => playNext(guildId));
  player.once('error', err => {
    console.error('Player error:', err);
    playNext(guildId);
  });
}

// --- STATUS ROTATION ---
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  allowedUsers.add(OWNER_ID);
  writeJson(ALLOWED_FILE, [...allowedUsers]);

  const activityTypes = [0, 2, 3, 5];
  const statuses = ['online', 'idle', 'dnd'];
  let i = Math.floor(Math.random() * activityTypes.length);

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
  setInterval(updatePresence, 60_000);
});

// --- COMMAND HANDLER ---
client.on('interactionCreate', async i => {
  if (!i.isCommand()) return;
  const cmd = i.commandName;
  const id = i.user.id;
  const isOwner = id === OWNER_ID;

  if (!['ping', 'min', 'help', 'play', 'skip', 'queue', 'np', 'disconnect', 'pause', 'clearqueue', 'queueshift'].includes(cmd)
    && !allowedUsers.has(id) && !isOwner)
    return i.reply({ content: '❌ Not allowed.', ephemeral: true });

  if (cmd === 'min') return i.reply('Min!');
  if (cmd === 'ping') return i.reply('🏓 Pong!');
  if (cmd === 'help')
    return i.reply('🎵 `/play` `/skip` `/queue` `/np` `/pause` `/disconnect` `/clearqueue` `/queueshift`');

  const guildId = i.guildId;
  await ensureQueue(guildId);
  const q = musicQueues[guildId];

  // --- MUSIC COMMANDS ---
  if (cmd === 'play') {
    const query = i.options.getString('query');
    const member = i.member;
    if (!member.voice.channel)
      return i.reply({ content: 'Join a voice channel first.', ephemeral: true });

    let info;
    try {
      const ytValid = playdl.yt_validate(query);
      if (ytValid === 'video') info = await playdl.video_info(query);
      else {
        const search = await playdl.search(query, { limit: 1 });
        info = search[0];
      }
    } catch {
      return i.reply('❌ Could not find that song.');
    }

    const song = {
      title: info.video_details.title,
      url: info.video_details.url,
      requestedBy: i.user.tag
    };
    q.queue.push(song);
    writeJson(MUSIC_FILE, musicQueues);

    if (!getVoiceConnection(guildId)) {
      joinVoiceChannel({
        channelId: member.voice.channel.id,
        guildId,
        adapterCreator: member.guild.voiceAdapterCreator
      });
    }

    if (!q.playing) setTimeout(() => playNext(guildId), 1000);
    return i.reply(`✅ Queued: **${song.title}**`);
  }

  if (cmd === 'skip') {
    const player = players.get(guildId);
    if (!player) return i.reply('Nothing playing.');
    player.stop();
    return i.reply('⏭ Skipped.');
  }

  if (cmd === 'pause') {
    const player = players.get(guildId);
    if (!player) return i.reply('Nothing playing.');
    if (paused.get(guildId)) {
      player.unpause();
      paused.set(guildId, false);
      return i.reply('▶️ Resumed.');
    } else {
      player.pause();
      paused.set(guildId, true);
      return i.reply('⏸️ Paused.');
    }
  }

  if (cmd === 'disconnect') {
    const conn = getVoiceConnection(guildId);
    if (!conn) return i.reply('❌ Not connected.');
    conn.destroy();
    if (players.has(guildId)) players.delete(guildId);
    q.playing = false;
    q.nowPlaying = null;
    writeJson(MUSIC_FILE, musicQueues);
    return i.reply('👋 Disconnected.');
  }

  if (cmd === 'clearqueue') {
    q.queue = [];
    writeJson(MUSIC_FILE, musicQueues);
    return i.reply('🧹 Cleared the queue.');
  }

  if (cmd === 'queueshift') {
    const from = i.options.getInteger('from') - 1;
    const to = i.options.getInteger('to') - 1;
    if (from < 0 || from >= q.queue.length || to < 0 || to >= q.queue.length)
      return i.reply('❌ Invalid positions.');
    const [moved] = q.queue.splice(from, 1);
    q.queue.splice(to, 0, moved);
    writeJson(MUSIC_FILE, musicQueues);
    return i.reply(`🔀 Moved **${moved.title}** to position ${to + 1}.`);
  }

  if (cmd === 'queue') {
    if (!q.queue.length) return i.reply('🎶 Queue is empty.');
    const list = q.queue
      .slice(0, 10)
      .map((s, idx) => `${idx + 1}. [${s.title}](${s.url})`)
      .join('\n');
    return i.reply({ content: `🎵 **Queue:**\n${list}` });
  }

  if (cmd === 'np') {
    if (!q.nowPlaying) return i.reply('❌ Nothing playing.');
    const current = q.nowPlaying;
    const elapsed = (Date.now() - (current.startedAt || 0)) / 1000;
    const duration = current.duration || 0;
    const progress = Math.min(elapsed / duration, 1);
    const bar =
      '▰'.repeat(Math.floor(progress * 15)) +
      '▱'.repeat(15 - Math.floor(progress * 15));
    const fmt = s =>
      `${Math.floor(s / 60)}:${Math.floor(s % 60)
        .toString()
        .padStart(2, '0')}`;

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎶 Now Playing')
          .setDescription(`[${current.title}](${current.url})`)
          .setColor(0x5865f2)
          .addFields(
            { name: 'Progress', value: bar },
            { name: 'Time', value: `\`${fmt(elapsed)} / ${fmt(duration)}\`` }
          )
          .setFooter({ text: `Requested by ${current.requestedBy}` })
          .setTimestamp()
      ]
    });
  }
});

// --- DASHBOARD + KEEPALIVE ---
const app = express();
app.use(express.urlencoded({ extended: true }));
const limiter = rateLimit({ windowMs: 60_000, max: 10 });
app.use('/dashboard', limiter);

app.get('/', (req, res) =>
  res.send('<h2>Bot is alive. Go to <a href="/dashboard">/dashboard</a></h2>')
);
app.get('/dashboard', (req, res) => {
  res.send(`
  <html><body>
    <form method="POST" action="/dashboard">
      <label>Password: <input name="pw" type="password"/></label>
      <button>Login</button>
    </form>
  </body></html>`);
});
app.post('/dashboard', (req, res) => {
  if (req.body.pw !== DASHBOARD_PASSWORD) return res.status(401).send('Unauthorized');
  const guilds = client.guilds.cache.size;
  const users = client.users.cache.size;
  res.send(`<h1>Dashboard</h1>
    <p>Guilds: ${guilds}</p>
    <p>Users: ${users}</p>
    <p>Uptime: ${prettyMs(process.uptime() * 1000)}</p>`);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT}`));

// --- STARTUP ---
client.login(token);
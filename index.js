// ---------- Modern Discord Bot (Render Compatible) ----------
// Includes: Dashboard, Music System (play-dl), Rotating Status, Economy Ready

// ------------- Imports -------------
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  Collection
} = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
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

// ------------- Initialize play-dl (fix YouTube fetching) -------------
(async () => {
  try {
    await playdl.setToken({
      youtube: { cookie: process.env.YT_COOKIE || "" }
    });
    console.log("🎵 play-dl initialized successfully.");
  } catch (err) {
    console.log("⚠️ Could not initialize play-dl:", err.message);
  }
})();

// ------------- Secrets -------------
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'defaultpassword';

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error("❌ Missing TOKEN, CLIENT_ID or OWNER_ID. Add them in Render environment.");
  process.exit(1);
}

// ------------- File setup -------------
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

const MUSIC_FILE = path.join(DATA_DIR, 'musicQueues.json');
let musicQueues = readJson(MUSIC_FILE, {});
const saveMusic = () => writeJson(MUSIC_FILE, musicQueues);

// ------------- Client setup -------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

const rest = new REST({ version: '10' }).setToken(TOKEN);
const players = new Map();

// ------------- Music Functions -------------
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
    console.error("🎵 Stream error:", err);
    playNext(guildId);
  }
}

// ------------- Slash Commands -------------
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  new SlashCommandBuilder().setName('play').setDescription('Play a song').addStringOption(o => o.setName('query').setDescription('URL or song name').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
  new SlashCommandBuilder().setName('queue').setDescription('Show music queue'),
  new SlashCommandBuilder().setName('np').setDescription('Now playing with progress'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause current song'),
  new SlashCommandBuilder().setName('disconnect').setDescription('Disconnect bot from voice'),
  new SlashCommandBuilder().setName('clearqueue').setDescription('Clear the queue'),
  new SlashCommandBuilder().setName('queueshift')
    .setDescription('Move a song in the queue to a new position')
    .addIntegerOption(o => o.setName('from').setDescription('Current position').setRequired(true))
    .addIntegerOption(o => o.setName('to').setDescription('New position').setRequired(true))
];

(async () => {
  try {
    console.log('🔁 Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Slash commands updated globally.');
  } catch (err) {
    console.error('Register error:', err);
  }
})();

// ------------- Interaction Commands -------------
client.on('interactionCreate', async i => {
  try {
    if (!i.isChatInputCommand()) return;
    const cmd = i.commandName;
    const guildId = i.guildId;

    await ensureQueue(guildId);

    if (cmd === 'ping') return i.reply(`🏓 Pong! ${client.ws.ping}ms`);

    // PLAY
    if (cmd === 'play') {
      const query = i.options.getString('query');
      const member = i.member;
      if (!member.voice.channel)
        return i.reply({ content: '❌ Join a voice channel first!', ephemeral: true });

      let song = null;
      try {
        const ytType = playdl.yt_validate(query);
        if (ytType === 'video') {
          const info = await playdl.video_info(query);
          song = { title: info.video_details.title, url: info.video_details.url, requestedBy: i.user.tag };
        } else {
          const search = await playdl.search(query, { source: { youtube: "video" }, limit: 1 });
          if (search.length) {
            song = { title: search[0].title, url: search[0].url, requestedBy: i.user.tag };
          }
        }
      } catch (err) {
        console.error("❌ play-dl search error:", err);
      }

      if (!song) return i.reply('❌ Could not find that song.');

      musicQueues[guildId].queue.push(song);
      saveMusic();

      if (!getVoiceConnection(guildId)) {
        joinVoiceChannel({
          channelId: member.voice.channel.id,
          guildId,
          adapterCreator: member.guild.voiceAdapterCreator
        });
      }

      if (!musicQueues[guildId].playing) setTimeout(() => playNext(guildId), 1000);
      return i.reply(`✅ Queued: **${song.title}**`);
    }

    // SKIP
    if (cmd === 'skip') {
      const player = players.get(guildId);
      if (!player) return i.reply('❌ Nothing playing.');
      player.stop();
      return i.reply('⏭ Skipped.');
    }

    // QUEUE
    if (cmd === 'queue') {
      const q = musicQueues[guildId];
      if (!q.queue.length) return i.reply('🎶 Queue is empty.');
      const list = q.queue.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n');
      return i.reply({ content: `🎵 **Queue:**\n${list}` });
    }

    // NOW PLAYING
    if (cmd === 'np') {
      const q = musicQueues[guildId];
      if (!q.nowPlaying) return i.reply('❌ Nothing is playing.');
      const current = q.nowPlaying;
      const elapsed = (Date.now() - (current.startedAt || 0)) / 1000;
      const duration = current.duration || 0;
      const bar = '▰'.repeat(Math.floor((elapsed / duration) * 15)) + '▱'.repeat(15 - Math.floor((elapsed / duration) * 15));
      const format = s => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
      return i.reply({
        embeds: [{
          title: '🎶 Now Playing',
          description: `[${current.title}](${current.url})`,
          color: 0x5865F2,
          fields: [
            { name: 'Progress', value: bar },
            { name: 'Time', value: `\`${format(elapsed)} / ${format(duration)}\`` }
          ],
          footer: { text: `Requested by ${current.requestedBy}` },
          timestamp: new Date()
        }]
      });
    }

    // PAUSE
    if (cmd === 'pause') {
      const player = players.get(guildId);
      if (!player) return i.reply('❌ Nothing playing.');
      player.pause();
      return i.reply('⏸️ Paused.');
    }

    // DISCONNECT
    if (cmd === 'disconnect') {
      const conn = getVoiceConnection(guildId);
      if (!conn) return i.reply('❌ Not connected.');
      conn.destroy();
      return i.reply('👋 Disconnected.');
    }

    // CLEAR QUEUE
    if (cmd === 'clearqueue') {
      musicQueues[guildId].queue = [];
      saveMusic();
      return i.reply('🧹 Cleared queue.');
    }

    // QUEUE SHIFT
    if (cmd === 'queueshift') {
      const from = i.options.getInteger('from') - 1;
      const to = i.options.getInteger('to') - 1;
      const q = musicQueues[guildId].queue;
      if (from < 0 || to < 0 || from >= q.length || to >= q.length)
        return i.reply('❌ Invalid positions.');
      const [song] = q.splice(from, 1);
      q.splice(to, 0, song);
      saveMusic();
      return i.reply(`↕️ Moved **${song.title}** to position ${to + 1}.`);
    }
  } catch (err) {
    console.error("Command error:", err);
    if (!i.replied) i.reply({ content: '⚠️ Error occurred.', ephemeral: true });
  }
});

// ------------- Dashboard + Keep Alive -------------
const app = express();
app.use(express.urlencoded({ extended: true }));
const dashLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true });
app.use('/dashboard', dashLimiter);

app.get('/', (req, res) => res.send('<h2>Bot is alive. Visit <a href="/dashboard">Dashboard</a>.</h2>'));
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
  const g = client.guilds.cache.size;
  const u = client.users.cache.size;
  res.send(`<h1>Dashboard</h1><p>Guilds: ${g}</p><p>Users: ${u}</p><p>Uptime: ${prettyMs(process.uptime() * 1000)}</p>`);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT}`));

// ------------- Startup -------------
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // 🎮 Rotate activity
  const activityTypes = [0, 2, 3, 5];
  const statuses = ['online', 'idle', 'dnd'];
  let i = 0;
  const updatePresence = () => {
    const type = activityTypes[i % activityTypes.length];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    client.user.setPresence({ activities: [{ name: 'at /min', type }], status });
    console.log(`🌀 Presence updated: ${type}, ${status}`);
    i++;
  };
  updatePresence();
  setInterval(updatePresence, 60000);
});

client.login(TOKEN);
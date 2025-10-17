// Modern Discord Bot — full music system + dashboard + rotating status
// Render-compatible and safe

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection
} = require('@discordjs/voice');
const express = require('express');
const playdl = require('play-dl');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const prettyMs = require('pretty-ms');
require('dotenv').config();

// ----- ENV -----
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'defaultpassword';
const MUSIC_FILE = './musicQueues.json';
const ALLOWED_FILE = './allowedUsers.json';

// ----- DATA -----
let musicQueues = {};
let allowedUsers = new Set();
if (!fs.existsSync(MUSIC_FILE)) fs.writeFileSync(MUSIC_FILE, JSON.stringify({}));
if (!fs.existsSync(ALLOWED_FILE)) fs.writeFileSync(ALLOWED_FILE, JSON.stringify([]));
try {
  musicQueues = JSON.parse(fs.readFileSync(MUSIC_FILE, 'utf8'));
  allowedUsers = new Set(JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf8')));
} catch {
  musicQueues = {};
  allowedUsers = new Set();
}
const save = () => {
  fs.writeFileSync(MUSIC_FILE, JSON.stringify(musicQueues, null, 2));
  fs.writeFileSync(ALLOWED_FILE, JSON.stringify([...allowedUsers], null, 2));
};

// ----- DISCORD CLIENT -----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const rest = new REST({ version: '10' }).setToken(TOKEN);

// ----- COMMANDS -----
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies with pong!'),
  new SlashCommandBuilder().setName('help').setDescription('Shows help info.'),
  new SlashCommandBuilder().setName('play').setDescription('Play music').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause current song'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and clear the queue'),
  new SlashCommandBuilder().setName('queue').setDescription('Show current queue'),
  new SlashCommandBuilder().setName('clearqueue').setDescription('Clear the music queue'),
  new SlashCommandBuilder().setName('np').setDescription('Show now playing info'),
  new SlashCommandBuilder().setName('disconnect').setDescription('Disconnect bot from VC'),
  new SlashCommandBuilder().setName('queueshift')
    .setDescription('Move a song in the queue to a new position')
    .addIntegerOption(o => o.setName('from').setDescription('Current position').setRequired(true))
    .addIntegerOption(o => o.setName('to').setDescription('New position').setRequired(true))
];

async function registerAll() {
  console.log('🔁 Registering slash commands globally...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
  console.log('✅ Slash commands registered globally.');
}

// ----- MUSIC LOGIC -----
const players = new Map();

function ensureQueue(gid) {
  if (!musicQueues[gid]) musicQueues[gid] = { queue: [], playing: false, nowPlaying: null };
}

async function playNext(gid) {
  ensureQueue(gid);
  const q = musicQueues[gid];
  if (!q.queue.length) {
    q.playing = false;
    q.nowPlaying = null;
    save();
    return;
  }

  const song = q.queue.shift();
  const conn = getVoiceConnection(gid);
  if (!conn) return;
  const stream = await playdl.stream(song.url);
  const res = createAudioResource(stream.stream, { inputType: stream.type });
  const player = players.get(gid) || createAudioPlayer();

  player.play(res);
  conn.subscribe(player);

  q.playing = true;
  q.nowPlaying = {
    ...song,
    startedAt: Date.now(),
    duration: stream.video_details?.durationInSec || 0
  };
  players.set(gid, player);
  save();

  player.once(AudioPlayerStatus.Idle, () => playNext(gid));
  player.once('error', err => {
    console.error('Player error:', err);
    playNext(gid);
  });
}

// ----- PRESENCE -----
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  allowedUsers.add(OWNER_ID);
  save();
  await registerAll();

  const activityTypes = [0, 2, 3, 5];
  const statuses = ['online', 'idle', 'dnd'];
  let i = 0;

  const updatePresence = () => {
    const type = activityTypes[i % activityTypes.length];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    client.user.setPresence({ activities: [{ name: 'at /min', type }], status });
    console.log(`🌀 Presence updated: ${status}, type ${type}`);
    i++;
  };

  updatePresence();
  setInterval(updatePresence, 60000);
});

// ----- COMMAND HANDLER -----
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  const cmd = i.commandName;
  const gid = i.guildId;
  const id = i.user.id;
  const member = i.member;
  const isOwner = id === OWNER_ID;
  ensureQueue(gid);

  try {
    if (cmd === 'ping') return i.reply('🏓 Pong!');
    if (cmd === 'help')
      return i.reply('🎵 `/play <song>` to play music | `/queue` to see queue | `/skip`, `/pause`, `/np`, `/stop`');

    if (['play', 'skip', 'pause', 'queue', 'np', 'stop', 'disconnect', 'clearqueue', 'queueshift'].includes(cmd)) {
      if (!member.voice?.channel) return i.reply('❌ You must be in a voice channel.');

      const q = musicQueues[gid];
      const conn = getVoiceConnection(gid);

      if (cmd === 'play') {
        const query = i.options.getString('query');
        let info;
        try {
          const ytValid = playdl.yt_validate(query);
          if (ytValid === 'video') info = await playdl.video_info(query);
          else {
            const search = await playdl.search(query, { limit: 1 });
            info = search[0];
          }
        } catch {
          return i.reply('❌ Could not find song.');
        }
        const song = {
          title: info.video_details.title,
          url: info.video_details.url,
          requestedBy: i.user.tag
        };
        q.queue.push(song);
        save();

        if (!conn) {
          joinVoiceChannel({
            channelId: member.voice.channel.id,
            guildId: gid,
            adapterCreator: member.guild.voiceAdapterCreator
          });
        }
        if (!q.playing) setTimeout(() => playNext(gid), 500);
        return i.reply(`✅ Queued **${song.title}**`);
      }

      if (cmd === 'pause') {
        const p = players.get(gid);
        if (!p) return i.reply('Nothing playing.');
        p.pause();
        return i.reply('⏸️ Paused.');
      }

      if (cmd === 'skip') {
        const p = players.get(gid);
        if (!p) return i.reply('Nothing to skip.');
        p.stop();
        return i.reply('⏭️ Skipped.');
      }

      if (cmd === 'stop') {
        const p = players.get(gid);
        if (p) p.stop();
        q.queue = [];
        q.playing = false;
        q.nowPlaying = null;
        save();
        return i.reply('⏹️ Stopped and cleared queue.');
      }

      if (cmd === 'disconnect') {
        const conn = getVoiceConnection(gid);
        if (conn) conn.destroy();
        q.playing = false;
        q.queue = [];
        save();
        return i.reply('👋 Disconnected.');
      }

      if (cmd === 'queue') {
        if (!q.queue.length) return i.reply('🎶 Queue is empty.');
        const list = q.queue
          .map((s, idx) => `${idx + 1}. [${s.title}](${s.url})`)
          .slice(0, 10)
          .join('\n');
        return i.reply({ content: `🎵 **Queue:**\n${list}` });
      }

      if (cmd === 'clearqueue') {
        q.queue = [];
        save();
        return i.reply('🗑️ Queue cleared.');
      }

      if (cmd === 'queueshift') {
        const from = i.options.getInteger('from') - 1;
        const to = i.options.getInteger('to') - 1;
        if (from < 0 || to < 0 || from >= q.queue.length || to >= q.queue.length)
          return i.reply('❌ Invalid positions.');
        const [song] = q.queue.splice(from, 1);
        q.queue.splice(to, 0, song);
        save();
        return i.reply(`↕️ Moved **${song.title}** to position ${to + 1}.`);
      }

      if (cmd === 'np') {
        const np = q.nowPlaying;
        if (!np) return i.reply('❌ Nothing playing.');
        const elapsed = (Date.now() - (np.startedAt || 0)) / 1000;
        const dur = np.duration || 0;
        const progress = Math.min(elapsed / dur, 1);
        const bar = '▰'.repeat(Math.floor(progress * 15)) + '▱'.repeat(15 - Math.floor(progress * 15));
        const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        return i.reply({
          embeds: [
            {
              title: '🎶 Now Playing',
              description: `[${np.title}](${np.url})`,
              color: 0x5865f2,
              fields: [
                { name: 'Progress', value: bar },
                { name: 'Time', value: `\`${fmt(elapsed)} / ${fmt(dur)}\`` }
              ],
              footer: { text: `Requested by ${np.requestedBy}` }
            }
          ]
        });
      }
    }
  } catch (err) {
    console.error('Command error:', err);
    if (!i.replied) i.reply({ content: '⚠️ Error occurred.', ephemeral: true });
  }
});

// ----- DASHBOARD -----
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 60000, max: 10 }));

app.get('/', (req, res) =>
  res.send('<h2>Bot is alive! Visit <a href="/dashboard">/dashboard</a></h2>')
);

app.get('/dashboard', (req, res) => {
  res.send(`
  <html><body>
  <form method="POST" action="/dashboard">
  <label>Password: <input name="pw" type="password"/></label>
  <button type="submit">Login</button>
  </form></body></html>`);
});

app.post('/dashboard', (req, res) => {
  if (req.body.pw !== DASHBOARD_PASSWORD)
    return res.status(401).send('Unauthorized');
  res.send(`<h1>Dashboard</h1>
    <p>Guilds: ${client.guilds.cache.size}</p>
    <p>Users: ${client.users.cache.size}</p>
    <p>Uptime: ${prettyMs(process.uptime() * 1000)}</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT}`));

// ----- LOGIN -----
client.login(TOKEN);
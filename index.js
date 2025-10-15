const { Client, GatewayIntentBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const fs = require('fs');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection
} = require('@discordjs/voice');
const playdl = require('play-dl');

// --- ENVIRONMENT VARIABLES ---
const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
const ownerId = process.env.OWNER_ID;
const OWNER_ID = ownerId;

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
  if (!fs.existsSync(MUSIC_FILE)) fs.writeFileSync(MUSIC_FILE, JSON.stringify({}));
  musicQueues = JSON.parse(fs.readFileSync(MUSIC_FILE, 'utf8'));
} catch {
  musicQueues = {};
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- REGISTER COMMANDS ---
const commands = [
  { name: 'min', description: 'Replies with Min' },
  { name: 'ping', description: 'Replies with Pong' },
  { name: 'help', description: 'Min help' },
  { name: 'play', description: 'Play music from YouTube/Spotify/SoundCloud', options: [{ name: 'query', type: 3, description: 'URL or search', required: true }] },
  { name: 'skip', description: 'Skip current song' },
  { name: 'queue', description: 'Show the music queue' },
  { name: 'np', description: 'Show what’s playing now' }
];

const rest = new REST({ version: '9' }).setToken(token);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('✅ Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();

// --- CLIENT ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages]
});

// --- MUSIC PLAYER MANAGEMENT ---
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
  q.nowPlaying = { ...song, startedAt: Date.now(), duration: stream.video_details?.durationInSec || 0 };
  players.set(guildId, player);
  writeJson(MUSIC_FILE, musicQueues);

  player.once(AudioPlayerStatus.Idle, () => playNext(guildId));
  player.once('error', err => {
    console.error('Player error:', err);
    playNext(guildId);
  });
}

// --- PRESENCE ROTATION ---
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  allowedUsers.add(OWNER_ID);
  writeJson(ALLOWED_FILE, [...allowedUsers]);

  const activityTypes = [0, 2, 3, 5]; // Playing, Listening, Watching, Competing
  const statuses = ['online', 'idle', 'dnd'];
  let i = Math.floor(Math.random() * activityTypes.length);

  const updatePresence = () => {
    const activity = activityTypes[i % activityTypes.length];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    client.user.setPresence({ activities: [{ name: 'at /min', type: activity }], status });
    console.log(`🌀 Presence updated: type=${activity}, status=${status}`);
    i++;
  };

  updatePresence();
  setInterval(updatePresence, 60000);

  console.log('✅ Status rotation with dynamic presence started.');
});

// --- COMMAND HANDLER ---
client.on('interactionCreate', async i => {
  if (!i.isCommand()) return;
  const cmd = i.commandName;
  const id = i.user.id;
  const isOwner = id === OWNER_ID;

  // Restrict access except for simple commands
  if (!['ping', 'min', 'help', 'play', 'skip', 'queue', 'np'].includes(cmd) && !allowedUsers.has(id) && !isOwner)
    return i.reply({ content: '❌ You are not allowed to use this bot.', ephemeral: true });

  if (cmd === 'min') return i.reply('Min!');
  if (cmd === 'ping') return i.reply('🏓 Pong!');
  if (cmd === 'help') return i.reply('🎵 Use `/play <song>` to play music, `/skip` to skip, `/queue` to see songs.');

  // 🎵 MUSIC COMMANDS
  if (cmd === 'play') {
    const query = i.options.getString('query');
    const member = i.member;
    if (!member.voice.channel) return i.reply({ content: 'You must be in a voice channel.', ephemeral: true });

    await ensureQueue(i.guildId);

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

    const song = { title: info.video_details.title, url: info.video_details.url, requestedBy: i.user.tag };
    musicQueues[i.guildId].queue.push(song);
    writeJson(MUSIC_FILE, musicQueues);

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
    const st = players.get(i.guildId);
    if (!st) return i.reply('Nothing playing.');
    st.stop();
    return i.reply('⏭ Skipped.');
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
    const current = q.nowPlaying;
    const elapsed = (Date.now() - (current.startedAt || 0)) / 1000;
    const duration = current.duration || 0;
    const progress = Math.min(elapsed / duration, 1);
    const bar = '▰'.repeat(Math.floor(progress * 15)) + '▱'.repeat(15 - Math.floor(progress * 15));
    const formatTime = s => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
    return i.reply({
      embeds: [{
        title: '🎶 Now Playing',
        description: `[${current.title}](${current.url})`,
        color: 0x5865F2,
        fields: [
          { name: 'Progress', value: bar },
          { name: 'Time', value: `\`${formatTime(elapsed)} / ${formatTime(duration)}\`` }
        ],
        footer: { text: `Requested by ${current.requestedBy}` },
        timestamp: new Date()
      }]
    });
  }
});

client.login(token);
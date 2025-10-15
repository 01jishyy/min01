const { Client, GatewayIntentBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const fs = require('fs'); // <--- NEW: File System Import

// UPDATED: Now importing 'ownerId' from config.json
const { token, clientId, guildId, ownerId } = require('./config.json');

// --- START: NEW STATUS/ALLOWED USERS SETUP ---
const OWNER_ID = ownerId; // Uses the imported ownerId
const ALLOWED_FILE = './allowedUsers.json';

// Load allowed users from file, or create a new Set
let allowedUsers = new Set();
try {
  const data = fs.readFileSync(ALLOWED_FILE, 'utf8');
  allowedUsers = new Set(JSON.parse(data));
} catch (err) {
  console.log('✅ allowedUsers.json not found, creating a new one.');
}

// Helper function to write data to a JSON file
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Placeholder for your command registration logic
async function registerAll() {
  // In the future, you can put your command deployment logic here.
  // For now, we'll just log a message.
  console.log('⚙️ Commands registered/updated.');
}
// --- END: NEW STATUS/ALLOWED USERS SETUP ---


const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  {
    name: 'min',
    description: 'Replies with Min',
  },
  {
    name: 'ping',
    description: 'Replies with Pong',
  },
  {
    name: 'help',
    description: 'Min help',
  }
];

const rest = new REST({ version: '9' }).setToken(token);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();

// --- START: NEW client.once('ready') EVENT (Replaces the old one) ---
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // 👑 Ensure owner is always allowed
  allowedUsers.add(OWNER_ID);
  writeJson(ALLOWED_FILE, [...allowedUsers]);

  // 🎮 Rotate activity type (Playing, Listening, Watching, Competing)
  const activityTypes = [0, 2, 3, 5]; // 0=Playing, 2=Listening, 3=Watching, 5=Competing
  const statuses = ['online', 'idle', 'dnd']; // online, away, do not disturb

  let i = Math.floor(Math.random() * activityTypes.length); // random start

  // Function to update presence
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

  // Set initial presence and start rotation
  updatePresence();
  setInterval(updatePresence, 60_000); // change every 60s

  await registerAll();
  console.log('✅ Status rotation with dynamic presence started.');
});
// --- END: NEW client.once('ready') EVENT ---


client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'min') {
    await interaction.reply('Min!');
  } else if (commandName === 'ping') {
    await interaction.reply('Pong!');
  } else if (commandName === 'help') {
    await interaction.reply('You need Min help');
  }
});

client.login(token);

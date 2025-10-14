// index.js — Modern Discord bot (Slash + Prefix, Render compatible, safe)
// Author: you 👑
// Features: economy, XP, music (free play-dl), moderation, dashboard, custom cmds, etc.

// ------------- Imports -------------
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

require('dotenv').config();

// ------------- Secrets -------------
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'defaultpassword';
if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error("❌ Missing BOT_TOKEN, CLIENT_ID or OWNER_ID. Add them in Render Environment.");
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

const COMMANDS_FILE = path.join(DATA_DIR, 'commands.json');
const ALLOWED_FILE = path.join(DATA_DIR, 'allowed.json');
const PREFIXES_FILE = path.join(DATA_DIR, 'prefixes.json');
const ECON_FILE = path.join(DATA_DIR, 'economy.json');
const XP_FILE = path.join(DATA_DIR, 'xp.json');

let customCommands = readJson(COMMANDS_FILE, {});
let allowedUsers = new Set(readJson(ALLOWED_FILE, [OWNER_ID]));
let prefixes = readJson(PREFIXES_FILE, {});
let economy = readJson(ECON_FILE, {});
let xp = readJson(XP_FILE, {});

const saveAll = () => {
  writeJson(COMMANDS_FILE, customCommands);
  writeJson(ALLOWED_FILE, [...allowedUsers]);
  writeJson(PREFIXES_FILE, prefixes);
  writeJson(ECON_FILE, economy);
  writeJson(XP_FILE, xp);
};

// ------------- Client setup -------------
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

// ------------- Rate limiting -------------
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

// ------------- XP system -------------
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
    writeJson(XP_FILE, xp);
    return true;
  }
  writeJson(XP_FILE, xp);
  return false;
}

// ------------- Command registration -------------
function buildCommands() {
  const base = [
    new SlashCommandBuilder().setName('help').setDescription('Show help and invite link'),
    new SlashCommandBuilder().setName('ping').setDescription('Check latency'),
    new SlashCommandBuilder().setName('hi').setDescription('Say hi back'),
    new SlashCommandBuilder().setName('about').setDescription('About this bot'),
    new SlashCommandBuilder().setName('balance').setDescription('Check your balance'),
    new SlashCommandBuilder().setName('daily').setDescription('Claim daily reward'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Show top users'),
    new SlashCommandBuilder().setName('profile').setDescription('Show your stats'),
    new SlashCommandBuilder().setName('setprefix').setDescription('Set personal prefix').addStringOption(o => o.setName('prefix').setDescription('Prefix').setRequired(true)),
    new SlashCommandBuilder().setName('getprefix').setDescription('Get your prefix'),
    new SlashCommandBuilder().setName('allow').setDescription('Allow user (owner only)').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('remove').setDescription('Remove allowed user (owner only)').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('allowed').setDescription('List allowed users (owner only)'),
    new SlashCommandBuilder().setName('commands').setDescription('Show command categories')
  ];
  for (const [n, r] of Object.entries(customCommands)) {
    try {
      base.push(new SlashCommandBuilder().setName(n).setDescription(r.slice(0, 90) || 'Custom command'));
    } catch {}
  }
  return base.map(c => c.toJSON());
}

async function registerAll() {
  try {
    console.log('🔁 Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: buildCommands() });
    console.log('✅ Slash commands updated globally.');
  } catch (err) {
    console.error('Register error:', err);
  }
}

// ------------- Interactions -------------
client.on('interactionCreate', async i => {
  try {
    if (!i.isChatInputCommand()) return;
    const cmd = i.commandName;
    const id = i.user.id;
    const owner = id === OWNER_ID;

    if (cmd !== 'commands' && !allowedUsers.has(id)) return i.reply({ content: '❌ You are not allowed to use this bot.', ephemeral: true });
    if (isOnCooldown(cmd, id, 1200)) return i.reply({ content: '⏳ Slow down!', ephemeral: true });

    if (cmd === 'help') return i.reply('yooo, join up papi https://discord.gg/min');
    if (cmd === 'ping') return i.reply(`🏓 Pong! ${client.ws.ping}ms`);
    if (cmd === 'hi') return i.reply(`${i.user} hi!`);
    if (cmd === 'about') return i.reply('Bot built for fun + utility. Slash + prefix.');

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
      writeJson(ECON_FILE, economy);
      return i.reply(`✅ You got ${amt} coins!`);
    }

    if (cmd === 'leaderboard') {
      const arr = Object.entries(economy).map(([id, v]) => ({ id, bal: v.balance || 0 })).sort((a,b)=>b.bal-a.bal).slice(0,10);
      const txt = arr.map((a,i)=>`${i+1}. <@${a.id}> — ${a.bal}`).join('\n') || 'No data';
      return i.reply(`🏆 Leaderboard:\n${txt}`);
    }

    if (cmd === 'profile') {
      if (!xp[id]) xp[id] = { xp: 0, level: 0 };
      const bal = economy[id]?.balance || 0;
      const lev = xp[id].level;
      const xpval = xp[id].xp;
      return i.reply(`📊 ${i.user.tag}\n💰 Balance: ${bal}\n⭐ Level: ${lev}\nXP: ${xpval}`);
    }

    // Prefix mgmt
    if (cmd === 'setprefix') {
      let p = i.options.getString('prefix');
      p = p.replace(/[^\w~!@#$%^&*]/g, '').slice(0,4);
      prefixes[id] = p;
      writeJson(PREFIXES_FILE, prefixes);
      return i.reply({ content:`✅ Prefix set to \`${p}\``, ephemeral:true });
    }
    if (cmd === 'getprefix') {
      return i.reply({ content:`Your prefix: \`${prefixes[id] || '`'}\``, ephemeral:true });
    }

    // Allowlist mgmt
    if (cmd === 'allow') {
      if (!owner) return i.reply({ content:'❌ Owner only.', ephemeral:true });
      const u = i.options.getUser('user');
      allowedUsers.add(u.id);
      writeJson(ALLOWED_FILE, [...allowedUsers]);
      return i.reply(`✅ ${u.tag} added.`);
    }
    if (cmd === 'remove') {
      if (!owner) return i.reply({ content:'❌ Owner only.', ephemeral:true });
      const u = i.options.getUser('user');
      allowedUsers.delete(u.id);
      writeJson(ALLOWED_FILE, [...allowedUsers]);
      return i.reply(`✅ ${u.tag} removed.`);
    }
    if (cmd === 'allowed') {
      if (!owner) return i.reply({ content:'❌ Owner only.', ephemeral:true });
      return i.reply([...allowedUsers].map(id=>`<@${id}>`).join('\n') || 'None.');
    }

    if (cmd === 'commands') {
      return i.reply('📜 Command categories:\nUtility, Fun, Economy, Moderation, Owner');
    }

    // Custom commands
    if (customCommands[cmd]) return i.reply(customCommands[cmd].slice(0,1900));

  } catch (err) {
    console.error('Interaction error', err);
    if (!i.replied) i.reply({ content:'⚠️ Error occurred.', ephemeral:true });
  }
});

// ------------- Prefix commands -------------
client.on('messageCreate', async msg => {
  try {
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

    if (cmd !== 'commands' && !allowedUsers.has(id)) return msg.reply('❌ Not allowed.');
    if (isOnCooldown(`p_${cmd}`, id, 1000)) return msg.reply('⏳ Slow down.');

    if (cmd === 'ping') return msg.reply(`🏓 Pong! ${client.ws.ping}ms`);
    if (cmd === 'hi') return msg.reply(`${msg.author} hi!`);
    if (cmd === 'help') return msg.reply('yooo, join up papi https://discord.gg/min');
    if (cmd === 'balance') return msg.reply(`💰 ${msg.author.tag}: ${economy[id]?.balance || 0}`);

    if (customCommands[cmd]) return msg.reply(customCommands[cmd].slice(0,1900));

  } catch (err) { console.error('Msg handler error', err); }
});

// ------------- Keep-alive + Dashboard -------------
const app = express();
app.use(express.urlencoded({ extended: true }));

const dashLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true });
app.use('/dashboard', dashLimiter);

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
app.listen(PORT, () => console.log(`🌐 Dashboard + Keepalive on ${PORT}`));

// ------------- Startup -------------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  allowedUsers.add(OWNER_ID);
  writeJson(ALLOWED_FILE, [...allowedUsers]);
  await registerAll();
});

setInterval(saveAll, 30000);
client.login(TOKEN);

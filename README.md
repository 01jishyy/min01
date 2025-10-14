🧠 Discord Bot (Slash + Prefix Hybrid)

A modern, secure, multi-feature Discord bot built with discord.js v14.
Supports both slash commands and customizable prefix commands, with persistence and safety designed for Replit hosting.

🚀 Features

✅ Slash commands (modern and automatically registered)
✅ Customizable per-user prefix (default: `)
✅ Owner-only permission system
✅ Economy + XP leveling system
✅ Meme, translate, and urban dictionary fun commands
✅ Custom command creation (/addcommand)
✅ Basic moderation (/kick, /ban, /purge)
✅ Persistent data (JSON files)
✅ Automatic command registration
✅ Rate-limited, safe, and Replit-compatible
✅ Express keep-alive server (for UptimeRobot)

⚙️ Setup
1️⃣ Replit Secrets

Go to the lock 🔒 icon on the left sidebar and add:

Name	Value
BOT_TOKEN	your bot’s token (from Discord Developer Portal → Bot → Reset Token → Copy)
CLIENT_ID	your Application (Client) ID (from OAuth2 → General Information)
OWNER_ID	your Discord user ID (right-click yourself → Copy ID)
2️⃣ Files

Create a folder named data (if not already present), and inside it create these empty files:

commands.json   → {}
allowed.json    → []
prefixes.json   → {}
economy.json    → {}
xp.json         → {}

3️⃣ Install dependencies

In the Replit shell, run:

npm install discord.js@14 express node-fetch ms pretty-ms

4️⃣ Run the bot

Click Run ▶️.
You should see logs like:

Keep-alive server running on port 3000
Logged in as YourBotName
Registering commands...
Commands registered (global).

5️⃣ Keep it alive (24/7)

Copy your Replit web URL (example:
https://yourproject.yourusername.repl.co)

Go to UptimeRobot
.

Add a HTTP monitor that pings that URL every 5 minutes.
✅ This prevents Replit from sleeping.

💬 Example Commands
Slash (/)

/help → “yooo, join up papi https://discord.gg/min”

/ping → Pong response with ping

/hi → Greets you back

/addcommand name response → Add a new slash command

/setprefix → Change your prefix (e.g., !)

/balance → Check your coins

/daily → Claim coins

/leaderboard → Top 10 richest users

/profile → Shows your XP and level

/meme, /urban, /translate → Fun utilities

/kick, /ban, /purge → Moderation (owner only)

Prefix (default backtick)

Type commands in chat like:

`ping
`daily
`balance
`help


You can change your prefix per user via /setprefix.

🧩 Permissions (OAuth2)

When inviting the bot to servers, check these scopes and permissions:

Scopes:

✅ bot

✅ applications.commands

Permissions:

✅ Send Messages

✅ Read Messages/View Channels

✅ Use Slash Commands

✅ Embed Links (optional)

Generate your invite link using:

https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2147483648&scope=bot%20applications.commands


Replace YOUR_CLIENT_ID with your actual bot ID.

🔒 Safety

No tokens or personal data stored in files — only JSON IDs and balances.

No eval, no remote code execution.

Owner-only access to sensitive commands.

Rate limits on every command to prevent spam.

User data is only stored locally (you can delete JSONs anytime).

🧱 Files Overview
File	Purpose
index.js	Main bot logic
data/commands.json	Custom commands
data/allowed.json	Allowed user IDs
data/prefixes.json	User-specific prefixes
data/economy.json	Balances
data/xp.json	XP/levels
🧠 Optional Add-ons

You can easily expand this bot with:

🎵 Music commands (requires @discordjs/voice and discord-player)

🧮 Polls or giveaways

🗳️ Reaction roles

📊 Analytics (command usage tracking)

🌐 A web dashboard using Express

💾 Auto-save & Rate-limits

All data auto-saves every 30 seconds and whenever you change it.
Basic cooldowns (1–2 seconds) per user per command to stay within Discord API rate limits.

🪄 Credits

Developed with ❤️ using
discord.js v14
Express.js
Node.js (Replit)
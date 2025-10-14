# Overview

This is a Discord bot application built with Discord.js v14 that allows authorized users to create and manage custom slash commands dynamically. The bot persists custom commands and user permissions to JSON files, and includes a basic Express web server to maintain uptime (useful for hosting on platforms like Replit).

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Application Structure

The application follows a single-file Node.js architecture with a straightforward design:

**Main Components:**
- Discord bot client with slash command handling
- Express web server for keep-alive pinging
- File-based persistence layer using JSON files
- Environment-based configuration

**Design Rationale:**
This monolithic approach was chosen for simplicity and ease of deployment on platforms like Replit. For a bot with dynamic command creation features, this provides quick iteration without the complexity of a database setup.

## Bot Architecture

**Discord.js v14 Integration:**
- Uses Gateway intents (specifically `GatewayIntentBits.Guilds`) for minimal permission scope
- Implements slash commands using Discord's REST API and SlashCommandBuilder
- Leverages Discord.js Client for event handling and interaction management

**Command System:**
The bot implements a dynamic command registration system where:
1. Custom commands are stored in memory and persisted to `commands.json`
2. Commands can be created/modified by authorized users at runtime
3. Slash commands are registered with Discord's API using the REST client

**Authorization Model:**
- Owner-based permission system with a configurable `OWNER_ID`
- Additional users can be granted permissions, stored in `allowedUsers` Set
- Allowed users are persisted to `allowed.json` for persistence across restarts

## Data Persistence

**File-Based Storage:**
The application uses JSON files for data persistence instead of a database:

1. `commands.json` - Stores custom command definitions
2. `allowed.json` - Stores list of authorized user IDs

**Rationale:**
File-based storage was chosen because:
- Simple deployment requirements (no database setup needed)
- Low data volume (commands and user lists are small)
- Easy debugging and manual intervention when needed
- Suitable for single-instance deployments

**Trade-offs:**
- **Pros:** Zero infrastructure overhead, immediate persistence, human-readable
- **Cons:** Not suitable for high-frequency writes, no transaction support, single-instance only

## Keep-Alive Mechanism

**Express Web Server:**
A minimal Express server runs on port 3000 with a single health-check endpoint. This serves as a ping target for uptime monitoring services.

**Purpose:**
Many free hosting platforms (like Replit) sleep inactive applications. The web server allows external services to ping the bot periodically, keeping it active.

# External Dependencies

## Discord Platform
- **Discord.js v14.22.1** - Official Discord API library for Node.js
- Requires bot token (`BOT_TOKEN`) and client ID (`CLIENT_ID`) from Discord Developer Portal
- Uses Discord's slash command registration API

## Node.js Packages
- **express v5.1.0** - Web framework for keep-alive server
- **dotenv v17.2.3** - Environment variable management for sensitive credentials

## Environment Configuration
Required environment variables:
- `BOT_TOKEN` - Discord bot authentication token
- `CLIENT_ID` - Discord application client ID
- `OWNER_ID` - Primary administrator user ID

## Hosting Considerations
The architecture assumes deployment on platforms like Replit where:
- File system persistence is available
- HTTP endpoints can be pinged externally
- Environment variables can be configured securely
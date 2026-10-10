# FunPay Autolister Bot

A Node.js bot that bridges FunPay listing automation with Discord. Queue listing commands via Discord, get results posted back to a channel, and manage pets, holds, stock triggers, and trades — all from chat.

## Features

- 📋 **Command queue** — list, bulk-list, dry-run, and stock-check commands queue up and execute in order (with pause/resume and emergency stop)
- 🐾 **Pet & hold tracking** — confirmation holds for listings, stale-hold reminders, custom pet names
- 📦 **Stock triggers** — notifications with built-in dedupe window
- 🤝 **Trade queue** — pending trades, resolution, and history (last 50)
- 📜 **History** — recent successful actions with duplicate detection
- 🔔 **Discord integration** — results posted to a configured channel, offline alerts

## Requirements

- Node.js 18+
- A Discord bot token + application (client ID, guild ID, results channel ID)
- An API key for the worker/bot that executes the queued commands

## Setup

```bash
git clone https://github.com/barryugp1-collab/funpay-autolister-bot.git
cd funpay-autolister-bot
npm install
cp .env.example .env   # then fill in your values
npm start
```

### Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Your Discord bot token |
| `CLIENT_ID` | Discord application (client) ID |
| `GUILD_ID` | Discord server (guild) ID |
| `RESULTS_CHANNEL_ID` | Channel where results are posted |
| `API_KEY` | Key required by the worker polling the queue |
| `PORT` | HTTP server port (default `3000`) |

## Usage

The bot runs an Express server (`server.js`) that the worker polls for queued commands. Interact with it via Discord commands:

- Queue list / bulk / stock-check commands
- Pause, resume, or stop the queue
- Confirm or release holds
- View queue status and history

## Data

Runtime state is stored locally in `queue-data.json` (gitignored). Deleting that file resets the queue, history, and holds.

## License

All rights reserved.

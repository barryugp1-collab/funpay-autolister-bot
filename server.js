require('dotenv').config();
const express = require('express');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const store = require('./store');

const {
  DISCORD_TOKEN, CLIENT_ID, GUILD_ID, RESULTS_CHANNEL_ID, API_KEY, PORT,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !RESULTS_CHANNEL_ID || !API_KEY) {
  console.error('Missing required environment variables. Check Railway → Variables.');
  process.exit(1);
}

// TEMP DEBUG — remove once auth is confirmed working.
console.log('BOOT — API_KEY loaded as:', JSON.stringify(API_KEY), 'length:', API_KEY.length);

// ---------- Discord bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('list').setDescription('Queue a single brainrot listing')
    .addStringOption((o) => o.setName('brainrot').setDescription('Brainrot name').setRequired(true))
    .addStringOption((o) => o.setName('ms').setDescription('Target M/s, e.g. 62.5m/s').setRequired(false)),
  new SlashCommandBuilder().setName('bulk').setDescription('Queue multiple listings (one per line)')
    .addStringOption((o) => o.setName('items').setDescription('e.g. "Garama and Madundung 62.5m/s"').setRequired(true)),
  new SlashCommandBuilder().setName('queue').setDescription('Show pending (not-yet-delivered) commands'),
  new SlashCommandBuilder().setName('status').setDescription('Show bridge status'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the current run and clear pending commands'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause delivering new commands to the userscript'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume delivering commands'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear pending commands only'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
}

function fmtQueue(queue) {
  if (!queue.length) return 'Queue is empty.';
  return queue.map((c, i) => {
    if (c.type === 'list') return `${i + 1}. /list ${c.petName} ${c.targetMsRaw || ''}`.trim();
    if (c.type === 'bulk') return `${i + 1}. /bulk (${c.text.split('\n').filter(Boolean).length} items)`;
    if (c.type === 'stop') return `${i + 1}. /stop`;
    return `${i + 1}. ${c.type}`;
  }).join('\n');
}

client.on('ready', () => console.log(`Discord bot logged in as ${client.user.tag}`));

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try {
    if (commandName === 'list') {
      const petName = interaction.options.getString('brainrot', true);
      const ms = interaction.options.getString('ms') || '';
      store.enqueue('list', { petName, targetMsRaw: ms });
      await interaction.reply(`📥 Queued: **${petName}**${ms ? ` @ ${ms}` : ''}`);
    } else if (commandName === 'bulk') {
      const items = interaction.options.getString('items', true);
      store.enqueue('bulk', { text: items });
      const count = items.split('\n').map((l) => l.trim()).filter(Boolean).length;
      await interaction.reply(`📥 Queued bulk job with ~${count} line(s).`);
    } else if (commandName === 'queue') {
      const state = store.getStatus();
      await interaction.reply(`\`\`\`\n${fmtQueue(state.queue)}\n\`\`\``);
    } else if (commandName === 'status') {
      const state = store.getStatus();
      const online = state.lastPoll && (Date.now() - state.lastPoll < 30000);
      const lines = [
        `Bridge: ${online ? '🟢 online' : "🔴 offline (userscript hasn't polled recently)"}`,
        `Paused: ${state.paused ? '⏸ yes' : '▶️ no'}`,
        `Queued commands: ${state.queue.length}`,
        state.lastResult
          ? `Last result: ${state.lastResult.success ? '✅' : '❌'} ${state.lastResult.petName || ''}`
          : 'Last result: none yet',
      ];
      await interaction.reply(lines.join('\n'));
    } else if (commandName === 'stop') {
      store.stopNow();
      await interaction.reply('🛑 Stop sent. Pending list/bulk commands cleared.');
    } else if (commandName === 'pause') {
      store.setPaused(true);
      await interaction.reply('⏸ Paused. New commands will wait until /resume.');
    } else if (commandName === 'resume') {
      store.setPaused(false);
      await interaction.reply('▶️ Resumed.');
    } else if (commandName === 'clear') {
      store.clearQueue();
      await interaction.reply('🧹 Pending queue cleared.');
    }
  } catch (e) {
    console.error(e);
    if (!interaction.replied) await interaction.reply('⚠️ Something went wrong handling that command.');
  }
});

async function postResultToDiscord(result) {
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) return;
    if (result.success) {
      const lines = [
        '🚀 Listed successfully',
        '',
        `Pet: ${result.petName}${result.mutation ? ` [${result.mutation}]` : ''}`,
        result.targetMsRaw ? `M/s: ${result.targetMsRaw}` : null,
        `Customer price: $${Number(result.customerPrice).toFixed(2)}`,
        `Estimated payout: ~$${Number(result.estimatedPayout).toFixed(2)}`,
      ].filter(Boolean);
      await channel.send(lines.join('\n'));
    } else {
      await channel.send(`❌ Listing failed for **${result.petName || 'unknown item'}**\nError: ${result.error || 'unknown error'}`);
    }
  } catch (e) {
    console.error('Failed to post result to Discord:', e);
  }
}

// ---------- HTTP API (used by the userscript) ----------
const app = express();
app.use(express.json());

function checkAuth(req, res, next) {
  const key = req.header('x-api-key');
  console.log('AUTH CHECK — received:', JSON.stringify(key), 'expected:', JSON.stringify(API_KEY), 'match:', key === API_KEY);
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/queue', checkAuth, (req, res) => {
  res.json(store.drainDeliverable());
});

app.post('/api/result', checkAuth, async (req, res) => {
  const result = req.body || {};
  store.setLastResult(result);
  await postResultToDiscord(result);
  res.json({ ok: true });
});

app.get('/api/status', checkAuth, (req, res) => {
  res.json(store.getStatus());
});

async function main() {
  await client.login(DISCORD_TOKEN);
  await registerCommands();
  const port = PORT || 3000;
  app.listen(port, () => console.log(`API listening on port ${port}`));
}

main();

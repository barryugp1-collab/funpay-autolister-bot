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

// Must match the userscript's CONFIG exactly — these are the correct SAB in-game names.
const PET_NAMES = [
  'Garama and Madundung',
  'Burguro and Fryuro',
  'La Secret Combinasion',
  'Cash or Card',
  'Fragola La La La',
  'Festive 67',
  'Boppin Bunny',
  'Sammyni Fattini',
];

const MUTATIONS = [
  'Gold', 'Diamond', 'Rainbow', 'Lava', 'Galaxy',
  'Yin Yang', 'Bloodrot', 'Radioactive', 'Candy',
  'Cursed', 'Divine', 'Neon',
];

const TRAITS = [
  '10B', '26', ':3', 'Blue Balloon', 'Bombardiro', 'Brazil',
  'Bubblegum', 'Chocolate', 'Comet-struck', 'Crab Claw', 'Disco',
  'Explosive', 'Fire', 'Fireworks', 'Galactic', 'Glitched',
  'Granny', 'Green Balloon', 'Halo', 'Indonesia', "Jack O'Lantern Pet",
  'Lightning', 'Lucky', 'Matteo Hat', 'Meowl', 'Nyan',
  'Orange Balloon', 'Paint', 'Pink Balloon', 'Rainbow Balloon',
  'Red Balloon', 'Reindeer Pet', 'RIP Tombstone', 'Rose',
  'Santa Hat', 'Shark Fin', 'Skeleton', 'Skibidi', 'Sleepy',
  'Snowy', 'Sombrero', 'Spider', 'Strawberry', 'Taco',
  'Tie', 'UFO', 'Wet', 'Witching Hour', 'Zombie',
];

// ---------- Discord bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('list').setDescription('Queue a single brainrot listing')
    .addStringOption((o) => o.setName('brainrot').setDescription('Brainrot name').setRequired(true)
      .addChoices(...PET_NAMES.map((n) => ({ name: n, value: n }))))
    .addStringOption((o) => o.setName('ms').setDescription('Target M/s, e.g. 62.5m/s').setRequired(false))
    .addStringOption((o) => o.setName('mutation').setDescription('Mutation').setRequired(false)
      .addChoices(...MUTATIONS.map((m) => ({ name: m, value: m }))))
    .addStringOption((o) => o.setName('traits').setDescription('Type to search traits. Pick one, or comma-separate for multiple.').setRequired(false).setAutocomplete(true)),
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
    if (c.type === 'list') {
      const mut = c.mutation ? ` [${c.mutation}]` : '';
      const tr = c.traits && c.traits.length ? ` (${c.traits.join(', ')})` : '';
      return `${i + 1}. /list ${c.petName}${mut} ${c.targetMsRaw || ''}${tr}`.trim();
    }
    if (c.type === 'bulk') return `${i + 1}. /bulk (${c.text.split('\n').filter(Boolean).length} items)`;
    if (c.type === 'stop') return `${i + 1}. /stop`;
    return `${i + 1}. ${c.type}`;
  }).join('\n');
}

client.on('ready', () => console.log(`Discord bot logged in as ${client.user.tag}`));

client.on('interactionCreate', async (interaction) => {
  // --- Autocomplete for the traits field ---
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'traits') {
      const raw = focused.value || '';
      const parts = raw.split(',');
      const current = parts[parts.length - 1].trim().toLowerCase();
      const prefix = parts.slice(0, -1).map((s) => s.trim()).filter(Boolean);
      const matches = TRAITS.filter((t) => t.toLowerCase().includes(current)).slice(0, 25);
      const choices = matches.map((t) => {
        const full = [...prefix, t].join(', ');
        return { name: full.length > 100 ? full.slice(0, 100) : full, value: full };
      });
      await interaction.respond(choices);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try {
    if (commandName === 'list') {
      const petName = interaction.options.getString('brainrot', true);
      const ms = interaction.options.getString('ms') || '';
      const mutation = interaction.options.getString('mutation') || '';
      const traitsRaw = interaction.options.getString('traits') || '';
      const traits = traitsRaw.split(',').map((t) => t.trim()).filter(Boolean);
      store.enqueue('list', { petName, targetMsRaw: ms, mutation, traits });
      const mutTxt = mutation ? ` [${mutation}]` : '';
      const trTxt = traits.length ? ` (${traits.join(', ')})` : '';
      await interaction.reply(`📥 Queued: **${petName}**${mutTxt}${ms ? ` @ ${ms}` : ''}${trTxt}`);
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
      const sortedPrices = Array.isArray(result.sortedPrices) ? result.sortedPrices : [];
      const lines = [
        '🚀 Listed successfully',
        '',
        `Pet: ${result.petName}${result.mutation ? ` [${result.mutation}]` : ''}`,
        result.targetMsRaw ? `M/s: ${result.targetMsRaw}` : null,
        sortedPrices.length ? `Competitor prices: ${sortedPrices.map((p) => '$' + Number(p).toFixed(2)).join(', ')}` : null,
        (result.lowest !== undefined && result.lowest !== null) ? `Lowest competitor: $${Number(result.lowest).toFixed(2)}` : null,
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

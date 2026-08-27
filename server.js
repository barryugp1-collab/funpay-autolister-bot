require('dotenv').config();
const express = require('express');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
} = require('discord.js');
const store = require('./store');

const {
  DISCORD_TOKEN, CLIENT_ID, GUILD_ID, RESULTS_CHANNEL_ID, API_KEY, PORT,
  STOCK_BOT_ID,
  SCANNER_BOT_ID,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !RESULTS_CHANNEL_ID || !API_KEY) {
  console.error('Missing required environment variables. Check Railway → Variables.');
  process.exit(1);
}

const STALE_HOLD_MS = 5 * 60 * 1000;
const STALE_HOLD_REMINDER_COOLDOWN_MS = 10 * 60 * 1000;

const BASE_PET_NAMES = [
  'Garama and Madundung', 'Burguro and Fryuro', 'La Secret Combinasion', 'Cash or Card',
  'Fragola La La La', 'Festive 67', 'Boppin Bunny', 'Sammyni Fattini',
];
const MUTATIONS = [
  'Gold', 'Diamond', 'Rainbow', 'Lava', 'Galaxy', 'Yin Yang', 'Bloodrot',
  'Radioactive', 'Candy', 'Cursed', 'Divine', 'Neon',
];
const TRAITS = [
  '10B', '26', ':3', 'Blue Balloon', 'Bombardiro', 'Brazil', 'Bubblegum', 'Chocolate',
  'Comet-struck', 'Crab Claw', 'Disco', 'Explosive', 'Fire', 'Fireworks', 'Galactic',
  'Glitched', 'Granny', 'Green Balloon', 'Halo', 'Indonesia', "Jack O'Lantern Pet",
  'Lightning', 'Lucky', 'Matteo Hat', 'Meowl', 'Nyan', 'Orange Balloon', 'Paint',
  'Pink Balloon', 'Rainbow Balloon', 'Red Balloon', 'Reindeer Pet', 'RIP Tombstone',
  'Rose', 'Santa Hat', 'Shark Fin', 'Skeleton', 'Skibidi', 'Sleepy', 'Snowy', 'Sombrero',
  'Spider', 'Strawberry', 'Taco', 'Tie', 'UFO', 'Wet', 'Witching Hour', 'Zombie',
];

const TRAIT_ALIASES = { claws: 'Crab Claw' };
function normalizeTraitName(raw) {
  const key = raw.trim().toLowerCase();
  return TRAIT_ALIASES[key] || raw.trim();
}

function getAllPetNames() {
  return [...BASE_PET_NAMES, ...store.getCustomPetNames()];
}
function findTrackedName(rawName) {
  const needle = rawName.trim().toLowerCase();
  return getAllPetNames().find((p) => p.toLowerCase() === needle) || null;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  new SlashCommandBuilder().setName('list').setDescription('Queue a single brainrot listing')
    .addStringOption((o) => o.setName('brainrot').setDescription('Brainrot name — type to search').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('ms').setDescription('Target M/s, e.g. 62.5m/s').setRequired(false))
    .addStringOption((o) => o.setName('mutation').setDescription('Mutation').setRequired(false)
      .addChoices(...MUTATIONS.map((m) => ({ name: m, value: m }))))
    .addStringOption((o) => o.setName('traits').setDescription('Type to search. Comma-separate for multiple.').setRequired(false).setAutocomplete(true)),

  new SlashCommandBuilder().setName('bulk').setDescription('Queue multiple listings (one per line)')
    .addStringOption((o) => o.setName('items').setDescription('e.g. "Garama and Madundung 62.5m/s [Gold] {Fire,Lucky}"').setRequired(true)),

  new SlashCommandBuilder().setName('dry-run').setDescription('Check pricing without actually listing')
    .addStringOption((o) => o.setName('brainrot').setDescription('Brainrot name — type to search').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('ms').setDescription('Target M/s, e.g. 62.5m/s').setRequired(false))
    .addStringOption((o) => o.setName('mutation').setDescription('Mutation').setRequired(false)
      .addChoices(...MUTATIONS.map((m) => ({ name: m, value: m }))))
    .addStringOption((o) => o.setName('traits').setDescription('Comma-separate for multiple.').setRequired(false).setAutocomplete(true)),

  new SlashCommandBuilder().setName('relist').setDescription('Re-queue a listing using its last known settings')
    .addStringOption((o) => o.setName('brainrot').setDescription('Pick from recent history').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('ms').setDescription('Override M/s (optional)').setRequired(false))
    .addStringOption((o) => o.setName('mutation').setDescription('Override mutation (optional)').setRequired(false)
      .addChoices(...MUTATIONS.map((m) => ({ name: m, value: m }))))
    .addStringOption((o) => o.setName('traits').setDescription('Override traits, comma-separated (optional)').setRequired(false).setAutocomplete(true)),

  new SlashCommandBuilder().setName('tracked-pets').setDescription('Show all tracked brainrot names (original + auto-discovered)'),

  new SlashCommandBuilder().setName('queue').setDescription('Show pending (not-yet-delivered) commands'),
  new SlashCommandBuilder().setName('queue-remove').setDescription('Remove a pending command by its position in /queue')
    .addIntegerOption((o) => o.setName('index').setDescription('Position shown in /queue (1 = first)').setRequired(true)),

  new SlashCommandBuilder().setName('status').setDescription('Show bridge status'),
  new SlashCommandBuilder().setName('history').setDescription('Show recent listing history')
    .addIntegerOption((o) => o.setName('count').setDescription('How many entries (default 10)').setRequired(false)),

  new SlashCommandBuilder().setName('confirm').setDescription('Approve a held listing')
    .addIntegerOption((o) => o.setName('id').setDescription('Held item id').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('cancel').setDescription('Discard a held listing')
    .addIntegerOption((o) => o.setName('id').setDescription('Held item id').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('confirm-all').setDescription('Approve every currently held listing'),
  new SlashCommandBuilder().setName('cancel-all').setDescription('Discard every currently held listing'),

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
      return `${i + 1}. /list ${c.petName}${mut} ${c.targetMsRaw || ''}`.trim();
    }
    if (c.type === 'bulk') return `${i + 1}. /bulk (${c.text.split('\n').filter(Boolean).length} items)`;
    if (c.type === 'dryrun') return `${i + 1}. /dry-run ${c.petName}`;
    if (c.type === 'stock_check') return `${i + 1}. 📦 stock check: ${c.petName}`;
    if (c.type === 'confirm_list') return `${i + 1}. confirmed listing: ${c.petName}`;
    if (c.type === 'stop') return `${i + 1}. /stop`;
    return `${i + 1}. ${c.type}`;
  }).join('\n');
}

client.on('ready', () => console.log(`Discord bot logged in as ${client.user.tag}`));

function stripMd(s) { return s.replace(/\*\*/g, '').replace(/__/g, ''); }

function toMsRaw(dollars) {
  const trim = (n) => parseFloat(n.toFixed(4)).toString();
  if (dollars >= 1e9) return trim(dollars / 1e9) + 'B/s';
  return trim(dollars / 1e6) + 'M/s';
}

function parseStockMessage(rawContent) {
  const content = stripMd(rawContent);
  const entries = [];
  const re = /name:\s*(.+?)\s*\n\s*money per sec:\s*([\d.,]+)\s*\$\/s\s*\n\s*mutation:\s*(.*?)\s*\n\s*traits:\s*(.*?)(?=\n\s*name:|$)/gis;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1].trim();
    const dollars = parseFloat(m[2].replace(/,/g, ''));
    let mutation = m[3].trim();
    if (/^none$/i.test(mutation)) mutation = '';
    const traitsRaw = m[4].trim();
    const traits = (!traitsRaw || /^none$/i.test(traitsRaw))
      ? []
      : traitsRaw.split(',').map((t) => normalizeTraitName(t)).filter(Boolean);
    if (!name || isNaN(dollars)) continue;
    entries.push({ name, dollars, mutation, traits });
  }
  return entries;
}

async function handleStockMessage(message) {
  if (!message.content) return;
  if (STOCK_BOT_ID && message.author.id !== STOCK_BOT_ID) return;
  if (message.channel.id !== RESULTS_CHANNEL_ID) return;
  if (!message.content.toLowerCase().includes('money per sec')) return;

  const entries = parseStockMessage(message.content);
  if (!entries.length) return;

  const newlyAdded = [];

  for (const entry of entries) {
    let canonical = findTrackedName(entry.name);
    if (!canonical) {
      const added = store.addCustomPetName(entry.name);
      if (added) newlyAdded.push(entry.name);
      canonical = entry.name;
    }

    const targetMsRaw = toMsRaw(entry.dollars);
    const key = ['stock', canonical, entry.mutation, targetMsRaw, entry.traits.slice().sort().join(',')].join('|').toLowerCase();
    if (store.wasRecentlyTriggered(key)) continue;
    store.markTriggered(key);

    store.enqueue('stock_check', {
      petName: canonical,
      mutation: entry.mutation,
      targetMsRaw,
      traits: entry.traits,
    });

    try {
      const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
      if (channel) {
        await channel.send(`📦 Stock match: **${canonical}**${entry.mutation ? ` [${entry.mutation}]` : ''} @ ${targetMsRaw} — checking FunPay price…`);
      }
    } catch (e) { console.error('Failed to post stock-match note:', e); }
  }

  if (newlyAdded.length) {
    try {
      const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
      if (channel) {
        await channel.send(`🆕 New brainrot${newlyAdded.length > 1 ? 's' : ''} detected via stock feed, added to tracked list: **${newlyAdded.join('**, **')}**. Held above — use /confirm.`);
      }
    } catch (e) { console.error('Failed to post new-name note:', e); }
  }
}

function parseScannerLine(line) {
  const m = line.match(/^#\d+\s+(.+?)\s*\(\$?([\d.]+)\s*(M|B)\/s\)\s*\[([^\]]*)\]\s*\{([^}]*)\}\s*$/i);
  if (!m) return null;
  const petName = m[1].trim();
  const targetMsRaw = `${m[2]}${m[3].toUpperCase()}/s`;
  let mutation = m[4].trim();
  if (/^none$/i.test(mutation)) mutation = '';
  const traitsRaw = m[5].trim();
  const traits = (!traitsRaw || /^none$/i.test(traitsRaw))
    ? []
    : traitsRaw.split(',').map((t) => normalizeTraitName(t)).filter(Boolean);
  return { petName, targetMsRaw, mutation, traits };
}

function parseScannerMessage(rawContent) {
  const content = rawContent.replace(/```/g, '').replace(/\*\*/g, '');
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const parsed = parseScannerLine(line);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

async function handleScannerMessage(message) {
  if (!message.content) return;
  if (message.channel.id !== RESULTS_CHANNEL_ID) return;
  if (SCANNER_BOT_ID && message.author.id !== SCANNER_BOT_ID) return;
  if (!/#\d+\s+.+\(\$?[\d.]+\s*[mb]\/s\)/i.test(message.content)) return;

  const entries = parseScannerMessage(message.content);
  if (!entries.length) return;

  const bulkLines = [];
  const newlyAdded = [];

  // Keys seen in this message — used to allow duplicate stats within one message
  // (they're real distinct items) while still deduping across separate messages.
  const keysThisMessage = [];

  for (const entry of entries) {
    let canonical = findTrackedName(entry.petName);
    const wasAlreadyTracked = !!canonical;

    if (!canonical) {
      const added = store.addCustomPetName(entry.petName);
      if (added) newlyAdded.push(entry.petName);
      canonical = entry.petName;
    }

    const key = ['scan', canonical, entry.mutation, entry.targetMsRaw, entry.traits.slice().sort().join(',')].join('|').toLowerCase();

    // Skip only if triggered by a prior message — not by another line in this same message.
    if (store.wasRecentlyTriggered(key) && !keysThisMessage.includes(key)) {
      continue;
    }

    keysThisMessage.push(key);

    if (wasAlreadyTracked) {
      let line = canonical;
      if (entry.mutation) line += ` [${entry.mutation}]`;
      line += ` ${entry.targetMsRaw}`;
      if (entry.traits.length) line += ` {${entry.traits.join(',')}}`;
      bulkLines.push(line);
    } else {
      store.enqueue('stock_check', {
        petName: canonical,
        mutation: entry.mutation,
        targetMsRaw: entry.targetMsRaw,
        traits: entry.traits,
      });
    }
  }

  // Mark all keys after the loop so within-message entries don't block each other,
  // but subsequent messages with the same stats are correctly deduped.
  for (const key of keysThisMessage) {
    store.markTriggered(key);
  }

  if (bulkLines.length) {
    store.enqueue('bulk', { text: bulkLines.join('\n') });
    try {
      const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
      if (channel) {
        await channel.send(`📡 Scanner match — auto-queuing ${bulkLines.length} listing(s):\n\`\`\`\n${bulkLines.join('\n')}\n\`\`\``);
      }
    } catch (e) { console.error('Failed to post scanner-match note:', e); }
  }

  if (newlyAdded.length) {
    try {
      const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
      if (channel) {
        await channel.send(`🆕 New brainrot${newlyAdded.length > 1 ? 's' : ''} detected via scanner, added to tracked list: **${newlyAdded.join('**, **')}**. Held for your /confirm (check above).`);
      }
    } catch (e) { console.error('Failed to post new-name note:', e); }
  }
}

client.on('messageCreate', (message) => {
  handleStockMessage(message).catch((e) => console.error('Stock message handling error:', e));
  handleScannerMessage(message).catch((e) => console.error('Scanner message handling error:', e));
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);
    const cmd = interaction.commandName;

    if ((cmd === 'list' || cmd === 'dry-run') && focused.name === 'brainrot') {
      const q = (focused.value || '').toLowerCase();
      const matches = getAllPetNames().filter((n) => n.toLowerCase().includes(q)).slice(0, 25);
      await interaction.respond(matches.map((n) => ({ name: n, value: n })));
      return;
    }

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
      return;
    }

    if (cmd === 'relist' && focused.name === 'brainrot') {
      const q = (focused.value || '').toLowerCase();
      const seen = new Set();
      const state = store.getStatus();
      const opts = [];
      for (const h of state.history) {
        const key = (h.petName || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        if (q && !key.includes(q)) continue;
        seen.add(key);
        opts.push({ name: h.petName, value: h.petName });
        if (opts.length >= 25) break;
      }
      await interaction.respond(opts);
      return;
    }

    if ((cmd === 'confirm' || cmd === 'cancel') && focused.name === 'id') {
      const holds = store.listHolds();
      const opts = holds.slice(0, 25).map((h) => ({
        name: `#${h.id} ${h.petName}${h.mutation ? ' [' + h.mutation + ']' : ''} ${h.targetMsRaw || ''} → $${Number(h.customerPrice).toFixed(2)}`.slice(0, 100),
        value: h.id,
      }));
      await interaction.respond(opts);
      return;
    }

    await interaction.respond([]);
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
    } else if (commandName === 'dry-run') {
      const petName = interaction.options.getString('brainrot', true);
      const ms = interaction.options.getString('ms') || '';
      const mutation = interaction.options.getString('mutation') || '';
      const traitsRaw = interaction.options.getString('traits') || '';
      const traits = traitsRaw.split(',').map((t) => t.trim()).filter(Boolean);
      store.enqueue('dryrun', { petName, targetMsRaw: ms, mutation, traits });
      await interaction.reply(`🧪 Dry run queued for **${petName}** — no listing will be created.`);
    } else if (commandName === 'relist') {
      const petName = interaction.options.getString('brainrot', true);
      const msOverride = interaction.options.getString('ms');
      const mutationOverride = interaction.options.getString('mutation');
      const traitsOverrideRaw = interaction.options.getString('traits');
      const state = store.getStatus();
      const prior = state.history.find((h) => (h.petName || '').toLowerCase() === petName.toLowerCase() && h.success);
      const ms = msOverride || (prior ? prior.targetMsRaw : '') || '';
      const mutation = mutationOverride || (prior ? prior.mutation : '') || '';
      const traits = traitsOverrideRaw
        ? traitsOverrideRaw.split(',').map((t) => t.trim()).filter(Boolean)
        : (prior && prior.traits) || [];
      store.enqueue('list', { petName, targetMsRaw: ms, mutation, traits });
      await interaction.reply(`📥 Re-queued: **${petName}**${mutation ? ` [${mutation}]` : ''}${ms ? ` @ ${ms}` : ''}`);
    } else if (commandName === 'tracked-pets') {
      const base = BASE_PET_NAMES;
      const custom = store.getCustomPetNames();
      const lines = [
        `**Original (${base.length}):**`,
        base.map((n) => `• ${n}`).join('\n'),
      ];
      if (custom.length) {
        lines.push('', `**Auto-discovered (${custom.length}):**`, custom.map((n) => `• ${n}`).join('\n'));
      } else {
        lines.push('', '_No auto-discovered names yet._');
      }
      await interaction.reply(lines.join('\n'));
    } else if (commandName === 'queue') {
      const state = store.getStatus();

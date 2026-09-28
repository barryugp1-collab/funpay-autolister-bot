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
      await interaction.reply(`\`\`\`\n${fmtQueue(state.queue)}\n\`\`\``);
    } else if (commandName === 'queue-remove') {
      const idx = interaction.options.getInteger('index', true);
      const removed = store.removeAt(idx - 1);
      if (!removed) { await interaction.reply(`⚠️ No queued command at position ${idx}. Run /queue to check.`); return; }
      await interaction.reply(`🗑️ Removed: ${removed.type === 'list' ? `/list ${removed.petName} ${removed.targetMsRaw || ''}`.trim() : removed.type}`);
    } else if (commandName === 'status') {
      const state = store.getStatus();
      const online = state.lastPoll && (Date.now() - state.lastPoll < 30000);
      const holdCount = Object.keys(state.holds || {}).length;
      const lines = [
        `Bridge: ${online ? '🟢 online' : "🔴 offline (userscript hasn't polled recently)"}`,
        `Paused: ${state.paused ? '⏸ yes' : '▶️ no'}`,
        `Queued commands: ${state.queue.length}`,
        `Held for confirmation: ${holdCount}`,
        state.lastResult
          ? `Last result: ${state.lastResult.success ? '✅' : '❌'} ${state.lastResult.petName || ''}`
          : 'Last result: none yet',
      ];
      await interaction.reply(lines.join('\n'));
    } else if (commandName === 'history') {
      const count = interaction.options.getInteger('count') || 10;
      const items = store.getHistory(count);
      if (!items.length) { await interaction.reply('No history yet.'); return; }
      const lines = items.map((h) => {
        const when = new Date(h.timestamp).toLocaleTimeString();
        if (h.success) return `${when} ✅ ${h.petName}${h.mutation ? ` [${h.mutation}]` : ''} — $${Number(h.customerPrice).toFixed(2)}`;
        return `${when} ❌ ${h.petName || 'unknown'} — ${h.error || 'failed'}`;
      });
      await interaction.reply(`\`\`\`\n${lines.join('\n')}\n\`\`\``);
    } else if (commandName === 'confirm') {
      const id = interaction.options.getInteger('id', true);
      const hold = store.removeHold(id);
      if (!hold) { await interaction.reply(`⚠️ No held item with id #${id}.`); return; }
      store.enqueue('confirm_list', {
        petName: hold.petName, mutation: hold.mutation, targetMsRaw: hold.targetMsRaw,
        traits: hold.traits, price: hold.customerPrice, estimatedPayout: hold.estimatedPayout,
        lowest: hold.lowest, sortedPrices: hold.sortedPrices,
      });
      await interaction.reply(`✅ Confirmed #${id} — proceeding with **${hold.petName}** at $${Number(hold.customerPrice).toFixed(2)}.`);
    } else if (commandName === 'cancel') {
      const id = interaction.options.getInteger('id', true);
      const hold = store.removeHold(id);
      if (!hold) { await interaction.reply(`⚠️ No held item with id #${id}.`); return; }
      await interaction.reply(`🚫 Cancelled #${id} — **${hold.petName}** will not be listed.`);
    } else if (commandName === 'confirm-all') {
      const holds = store.listHolds();
      if (!holds.length) { await interaction.reply('No held items to confirm.'); return; }
      for (const hold of holds) {
        store.removeHold(hold.id);
        store.enqueue('confirm_list', {
          petName: hold.petName, mutation: hold.mutation, targetMsRaw: hold.targetMsRaw,
          traits: hold.traits, price: hold.customerPrice, estimatedPayout: hold.estimatedPayout,
          lowest: hold.lowest, sortedPrices: hold.sortedPrices,
        });
      }
      await interaction.reply(`✅ Confirmed ${holds.length} held item(s): ${holds.map((h) => h.petName).join(', ')}`);
    } else if (commandName === 'cancel-all') {
      const holds = store.listHolds();
      if (!holds.length) { await interaction.reply('No held items to cancel.'); return; }
      holds.forEach((h) => store.removeHold(h.id));
      await interaction.reply(`🚫 Cancelled ${holds.length} held item(s): ${holds.map((h) => h.petName).join(', ')}`);
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

async function postResultToDiscord(result, duplicateNote) {
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) return;
    if (result.success) {
      const sortedPrices = Array.isArray(result.sortedPrices) ? result.sortedPrices : [];
      const embed = new EmbedBuilder()
        .setTitle('🚀 Listed successfully')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Pet', value: `${result.petName}${result.mutation ? ` [${result.mutation}]` : ''}`, inline: true },
          ...(result.targetMsRaw ? [{ name: 'M/s', value: result.targetMsRaw, inline: true }] : []),
          ...(sortedPrices.length ? [{ name: 'Competitor prices', value: sortedPrices.map((p) => '$' + Number(p).toFixed(2)).join(', ') }] : []),
          ...(result.lowest != null ? [{ name: 'Lowest competitor', value: `$${Number(result.lowest).toFixed(2)}`, inline: true }] : []),
          { name: 'Customer price', value: `$${Number(result.customerPrice).toFixed(2)}`, inline: true },
          { name: 'Est. payout', value: `~$${Number(result.estimatedPayout).toFixed(2)}`, inline: true },
        )
        .setTimestamp(Date.now());
      if (duplicateNote) embed.setDescription(duplicateNote);
      await channel.send({ embeds: [embed] });
    } else {
      const embed = new EmbedBuilder()
        .setTitle('❌ Listing failed')
        .setColor(0xe74c3c)
        .addFields(
          { name: 'Pet', value: result.petName || 'unknown' },
          { name: 'Error', value: (result.error || 'unknown error').slice(0, 1000) },
        )
        .setTimestamp(Date.now());
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('Failed to post result to Discord:', e);
  }
}

async function postHoldAlert(id, data) {
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) return;
    const sortedPrices = Array.isArray(data.sortedPrices) ? data.sortedPrices : [];
    const embed = new EmbedBuilder()
      .setTitle(`⏸ Held for confirmation (#${id})`)
      .setColor(0xf1c40f)
      .setDescription(data.reason || 'Held for review.')
      .addFields(
        { name: 'Pet', value: `${data.petName}${data.mutation ? ` [${data.mutation}]` : ''}`, inline: true },
        ...(data.targetMsRaw ? [{ name: 'M/s', value: data.targetMsRaw, inline: true }] : []),
        ...(sortedPrices.length ? [{ name: 'Competitor prices', value: sortedPrices.map((p) => '$' + Number(p).toFixed(2)).join(', ') }] : []),
        { name: 'Would list at', value: `$${Number(data.customerPrice).toFixed(2)}`, inline: true },
        { name: 'Est. payout', value: `~$${Number(data.estimatedPayout).toFixed(2)}`, inline: true },
      )
      .setFooter({ text: `/confirm id:${id}  or  /cancel id:${id}  —  or /confirm-all / /cancel-all` });
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('Failed to post hold alert:', e);
  }
}

async function postDryRunResult(result) {
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) return;
    if (result.success) {
      const sortedPrices = Array.isArray(result.sortedPrices) ? result.sortedPrices : [];
      const embed = new EmbedBuilder()
        .setTitle('🧪 Dry run result')
        .setColor(0x3498db)
        .addFields(
          { name: 'Pet', value: `${result.petName}${result.mutation ? ` [${result.mutation}]` : ''}`, inline: true },
          ...(sortedPrices.length ? [{ name: 'Competitor prices', value: sortedPrices.map((p) => '$' + Number(p).toFixed(2)).join(', ') }] : []),
          { name: 'Would list at', value: `$${Number(result.customerPrice).toFixed(2)}`, inline: true },
          { name: 'Est. payout', value: `~$${Number(result.estimatedPayout).toFixed(2)}`, inline: true },
        )
        .setFooter({ text: 'No listing was created.' });
      await channel.send({ embeds: [embed] });
    } else {
      await channel.send(`🧪 Dry run failed for **${result.petName || 'unknown'}**: ${result.error || 'unknown error'}`);
    }
  } catch (e) {
    console.error('Failed to post dry run result:', e);
  }
}

async function postBulkProgress(p) {
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) return;
    const icon = p.success ? '✅' : '❌';
    await channel.send(`${icon} Bulk: ${p.petName} — ${p.itemsLeft} item(s) left in queue.`);
  } catch (e) {
    console.error('Failed to post bulk progress:', e);
  }
}

async function postSaleToDiscord(payload) {
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('🛒 Item Sold')
      .setColor(0x9b59b6)
      .addFields(
        { name: 'Buyer', value: payload.buyerName || 'unknown', inline: true },
        { name: 'Character', value: payload.characterName || 'unknown', inline: true },
        { name: 'Item', value: payload.itemTitle || 'unknown' },
        { name: 'Price', value: `$${Number(payload.price).toFixed(2)}`, inline: true },
        { name: 'Order', value: `#${payload.orderId}`, inline: true },
      )
      .setTimestamp(Date.now());
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('Failed to post sale to Discord:', e);
  }
}

async function postTradeResult(trade, result) {
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) return;

    if (result.status === 'success') {
      const embed = new EmbedBuilder()
        .setTitle('🤝 Trade Sent')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Buyer', value: trade.username, inline: true },
          { name: 'Pet', value: `${trade.petName}${trade.mutation && trade.mutation !== 'None' ? ` [${trade.mutation}]` : ''}`, inline: true },
          ...(trade.targetMsRaw ? [{ name: 'M/s', value: trade.targetMsRaw, inline: true }] : []),
          ...(trade.orderId ? [{ name: 'Order', value: `#${trade.orderId}`, inline: true }] : []),
        )
        .setTimestamp(Date.now());
      await channel.send({ embeds: [embed] });
    } else {
      const ERROR_LABELS = {
        player_not_found:  '❌ Player not in server',
        pet_not_found:     '❌ Pet not found in your base',
        trade_declined:    '❌ Trade declined by buyer',
        trade_timeout:     '⏱ Trade timed out (no response)',
        remote_error:      '❌ Trade remote failed',
        unknown:           '❌ Unknown error',
      };
      const label = ERROR_LABELS[result.error] || `❌ ${result.error || 'Unknown error'}`;
      const embed = new EmbedBuilder()
        .setTitle(label)
        .setColor(0xe74c3c)
        .addFields(
          { name: 'Buyer', value: trade.username, inline: true },
          { name: 'Pet', value: `${trade.petName}${trade.mutation && trade.mutation !== 'None' ? ` [${trade.mutation}]` : ''}`, inline: true },
          ...(trade.orderId ? [{ name: 'Order', value: `#${trade.orderId}`, inline: true }] : []),
          ...(result.detail ? [{ name: 'Detail', value: result.detail.slice(0, 500) }] : []),
        )
        .setFooter({ text: 'Use /trade-retry or handle manually.' })
        .setTimestamp(Date.now());
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('Failed to post trade result:', e);
  }
}

async function postStockIncrementToDiscord(payload) {
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('📦 Stock increased')
      .setColor(0x1abc9c)
      .addFields(
        { name: 'Pet', value: `${payload.petName}${payload.mutation ? ` [${payload.mutation}]` : ''}`, inline: true },
        ...(payload.targetMsRaw ? [{ name: 'M/s', value: payload.targetMsRaw, inline: true }] : []),
        { name: 'Offer', value: `#${payload.offerId}`, inline: true },
        { name: 'Stock', value: `${payload.oldAmount ?? '?'} → ${payload.newAmount}`, inline: true },
      )
      .setTimestamp(Date.now());
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('Failed to post stock increment to Discord:', e);
  }
}

const app = express();
app.use(express.json());

// ── AUTH — accepts both x-api-key header and Authorization: Bearer <key> ──
function checkAuth(req, res, next) {
  const key = req.header('x-api-key')
    || (req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/trade/test', checkAuth, async (req, res) => {
  const { username, petName } = req.body || {};
  if (!username || !petName) return res.status(400).json({ error: 'username and petName required' });
  const trade = store.queueTrade({ username, petName, orderId: 'TEST-' + Date.now() });
  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (channel) await channel.send(`🧪 Test trade queued — **${petName}** → \`${username}\``);
  } catch (e) { /* ignore */ }
  res.json({ ok: true, tradeId: trade.id });
});

app.get('/api/queue', checkAuth, (req, res) => {
  store.updateLastPoll();
  res.json(store.drainDeliverable());
});

app.post('/api/queue', checkAuth, (req, res) => {
  const payload = req.body || {};
  const command = payload.command || 'bulk';
  const pets = Array.isArray(payload.pets) ? payload.pets : [];

  if (!pets.length) return res.status(400).json({ error: 'no pets provided' });

  if (command === 'bulk') {
    const lines = pets.map((p) => {
      let line = p.name || p.petName || '';
      if (!line) return null;
      if (p.mps || p.targetMsRaw) line += ` ${p.mps || p.targetMsRaw}`;
      if (p.mutation && p.mutation !== 'None') line += ` [${p.mutation}]`;
      const traits = Array.isArray(p.traits)
        ? p.traits
        : (typeof p.traits === 'string' && p.traits && p.traits !== 'None'
            ? p.traits.split(',').map((t) => t.trim()).filter(Boolean)
            : []);
      if (traits.length) line += ` {${traits.join(',')}}`;
      return line;
    }).filter(Boolean);

    if (!lines.length) return res.status(400).json({ error: 'no valid pets after mapping' });
    store.enqueue('bulk', { text: lines.join('\n') });
    return res.json({ ok: true, queued: lines.length, command: 'bulk' });
  }

  if (command === 'confirm_list') {
    for (const p of pets) {
      const petName = p.name || p.petName || '';
      if (!petName) continue;
      const traits = Array.isArray(p.traits)
        ? p.traits
        : (typeof p.traits === 'string' && p.traits && p.traits !== 'None'
            ? p.traits.split(',').map((t) => t.trim()).filter(Boolean)
            : []);
      store.enqueue('confirm_list', {
        petName,
        mutation: p.mutation && p.mutation !== 'None' ? p.mutation : '',
        targetMsRaw: p.mps || p.targetMsRaw || '',
        traits,
      });
    }
    return res.json({ ok: true, queued: pets.length, command: 'confirm_list' });
  }

  return res.status(400).json({ error: `unknown command: ${command}` });
});

app.post('/api/result', checkAuth, async (req, res) => {
  const payload = req.body || {};

  if (payload.type === 'hold') {
    const id = store.holdForConfirmation(payload);
    await postHoldAlert(id, payload);
    res.json({ ok: true, holdId: id });
    return;
  }
  if (payload.type === 'bulk_progress') {
    await postBulkProgress(payload);
    res.json({ ok: true });
    return;
  }
  if (payload.type === 'dryrun') {
    await postDryRunResult(payload);
    res.json({ ok: true });
    return;
  }
  if (payload.type === 'sale') {
    await postSaleToDiscord(payload);
    res.json({ ok: true });
    return;
  }
  if (payload.type === 'stock_increment') {
    await postStockIncrementToDiscord(payload);
    res.json({ ok: true });
    return;
  }

  let duplicateNote = null;
  if (payload.success) {
    const dup = store.findRecentDuplicate(payload.petName, payload.mutation, payload.targetMsRaw, 30 * 60 * 1000);
    if (dup) duplicateNote = `⚠️ Same item was listed ${Math.round((Date.now() - dup.timestamp) / 60000)} min ago too.`;
  }
  store.setLastResult(payload);
  store.addHistory(payload);
  await postResultToDiscord(payload, duplicateNote);
  res.json({ ok: true });
});

app.get('/api/status', checkAuth, (req, res) => {
  res.json(store.getStatus());
});

// ── TRADE ENDPOINTS ────────────────────────────────────────────────
app.post('/api/trade', checkAuth, async (req, res) => {
  const { username, petName, mutation, targetMsRaw, traits, orderId } = req.body || {};
  if (!username || !petName) return res.status(400).json({ error: 'username and petName required' });

  const trade = store.queueTrade({ username, petName, mutation, targetMsRaw, traits, orderId });

  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (channel) {
      await channel.send(
        `📬 New order — queuing trade for **${petName}**${mutation && mutation !== 'None' ? ` [${mutation}]` : ''} → buyer: \`${username}\`${orderId ? ` (Order #${orderId})` : ''}`
      );
    }
  } catch (e) { console.error('Failed to post trade-queued note:', e); }

  res.json({ ok: true, tradeId: trade.id });
});

app.get('/api/trade/pending', checkAuth, (req, res) => {
  const trade = store.getPendingTrade();
  res.json({ trade: trade || null });
});

app.post('/api/trade/result', checkAuth, async (req, res) => {
  const { tradeId, status, error, detail } = req.body || {};
  if (!tradeId || !status) return res.status(400).json({ error: 'tradeId and status required' });

  const trade = store.resolveTrade(tradeId, { status, error, detail });
  if (!trade) return res.status(404).json({ error: 'trade not found' });

  await postTradeResult(trade, { status, error, detail });
  res.json({ ok: true });
});

async function main() {
  await client.login(DISCORD_TOKEN);
  await registerCommands();

  setInterval(async () => {
    const state = store.getStatus();
    if (!state.lastPoll) return;
    const offline = Date.now() - state.lastPoll > 40000;
    if (offline && !state.offlineAlerted) {
      store.markOfflineAlerted();
      try {
        const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
        if (channel) await channel.send("⚠️ Bridge went offline — the userscript hasn't polled in over 40 seconds. Make sure the FunPay tab is open and active.");
      } catch (e) { console.error('Failed to post offline alert:', e); }
    }
  }, 30000);

  setInterval(async () => {
    const stale = store.getStaleHolds(STALE_HOLD_MS, STALE_HOLD_REMINDER_COOLDOWN_MS);
    if (!stale.length) return;
    try {
      const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
      if (!channel) return;
      const lines = stale.map((h) => `#${h.id} ${h.petName}${h.mutation ? ` [${h.mutation}]` : ''} ${h.targetMsRaw || ''} → $${Number(h.customerPrice).toFixed(2)}`);
      await channel.send(`⏰ Reminder: ${stale.length} item(s) still waiting for /confirm or /cancel:\n\`\`\`\n${lines.join('\n')}\n\`\`\`\nUse /confirm-all to approve everything at once.`);
      stale.forEach((h) => store.markHoldReminded(h.id));
    } catch (e) { console.error('Failed to post stale-hold reminder:', e); }
  }, 60000);

  const port = PORT || 3000;
  app.listen(port, () => console.log(`API listening on port ${port}`));
}

main();

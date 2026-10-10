const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'queue-data.json');
const MAX_HISTORY = 50;
const STOCK_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function defaultState() {
  return {
    queue: [], inflight: [], paused: false, lastPoll: null, lastResult: null, nextId: 1,
    history: [], holds: {}, nextHoldId: 1, offlineAlerted: false,
    stockTriggers: {}, customPetNames: [],trades: [], tradeHistory: [],

  };
}

function load() {
  try {
    const state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!state.history) state.history = [];
    if (!state.holds) state.holds = {};
    if (!state.nextHoldId) state.nextHoldId = 1;
    if (state.offlineAlerted === undefined) state.offlineAlerted = false;
    if (!state.stockTriggers) state.stockTriggers = {};
    if (!state.customPetNames) state.customPetNames = [];
    if (!Array.isArray(state.inflight)) {
      // migrate pre-ack queue-data.json files: nothing was ever in-flight
      state.inflight = [];
    }
    return state;
  } catch (e) {
    return defaultState();
  }
}

// Atomic save: write to a temp file first, then rename over the real file.
// A crash mid-write can no longer leave a half-written (unparseable) state file.
function save(state) {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

// Every mutation runs inside update() so read-modify-write cycles on the
// state file are serialized (no lost updates from overlapping requests).
let writeChain = Promise.resolve();
function update(mutate) {
  writeChain = writeChain.then(() => {
    const state = load();
    const result = mutate(state);
    save(state);
    return result;
  });
  return writeChain;
}

function enqueue(type, payload) {
  return update((state) => {
    const cmd = { id: state.nextId++, type, ...payload, createdAt: Date.now() };
    state.queue.push(cmd);
    return cmd;
  });
}

function removeAt(index) {
  return update((state) => {
    if (index < 0 || index >= state.queue.length) return null;
    const [removed] = state.queue.splice(index, 1);
    return removed;
  });
}

function clearQueue() {
  return update((state) => {
    state.queue = [];
  });
}

function stopNow() {
  return update((state) => {
    state.queue = state.queue.filter((c) => !['list', 'bulk', 'confirm_list', 'dryrun', 'stock_check'].includes(c.type));
    state.queue.push({ id: state.nextId++, type: 'stop', createdAt: Date.now() });
  });
}

function setPaused(v) {
  return update((state) => {
    state.paused = v;
  });
}

function getStatus() { return load(); }

// Deliver a command to the worker WITHOUT deleting it. The command moves to
// inflight[]; it is only removed when the worker acks it via ackCommand().
// If the worker dies mid-execution, reapInflight() puts it back (or fails it
// after MAX retries). A crash between poll and ack no longer loses commands.
function drainDeliverable() {
  return update((state) => {
    const stops = state.queue.filter((c) => c.type === 'stop');
    state.queue = state.queue.filter((c) => c.type !== 'stop');

    let deliverable = [...stops];
    for (const s of deliverable) {
      s.deliveredAt = Date.now();
      s.retries = s.retries || 0;
      state.inflight.push(s);
    }

    if (!state.paused && state.queue.length) {
      const cmd = state.queue.shift();
      cmd.deliveredAt = Date.now();
      cmd.retries = cmd.retries || 0;
      state.inflight.push(cmd);
      deliverable.push(cmd);
    }

    state.lastPoll = Date.now();
    state.offlineAlerted = false;
    return { paused: state.paused, commands: deliverable };
  });
}

// Worker calls this after finishing a command:
//   POST /api/queue/ack { id, status: 'done' | 'failed' }
// 'done' removes it; 'failed' re-queues for retry (up to maxRetries).
function ackCommand(id, status) {
  return update((state) => {
    const idx = state.inflight.findIndex((c) => c.id === id);
    if (idx === -1) return { ok: false, error: 'command not in flight' };
    const cmd = state.inflight[idx];
    state.inflight.splice(idx, 1);
    if (status === 'failed') {
      cmd.retries = (cmd.retries || 0) + 1;
      state.queue.unshift(cmd); // retry before anything newer
    }
    return { ok: true, command: cmd };
  });
}

// Called on an interval by the server: anything still in flight after
// `timeoutMs` either goes back to the queue (retries < maxRetries) or is
// dropped (retries exhausted). Returns the re-queued commands so the server
// can log/notify about them.
function reapInflight(timeoutMs, maxRetries) {
  return update((state) => {
    const now = Date.now();
    const requeued = [];
    const keep = [];
    for (const cmd of state.inflight) {
      const age = now - (cmd.deliveredAt || cmd.createdAt);
      if (age < timeoutMs) { keep.push(cmd); continue; }
      cmd.retries = (cmd.retries || 0) + 1;
      if (cmd.retries <= maxRetries) {
        requeued.push(cmd);
      }
      // else: dropped after exhausting retries — history/results posted by
      // the worker remain the source of truth for what actually happened
    }
    state.inflight = keep;
    if (requeued.length) state.queue.unshift(...requeued);
    return requeued;
  });
}

function setLastResult(result) {
  return update((state) => {
    state.lastResult = { ...result, receivedAt: Date.now() };
  });
}

function addHistory(entry) {
  return update((state) => {
    state.history.unshift({ ...entry, timestamp: Date.now() });
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  });
}

function getHistory(count) {
  const state = load();
  return state.history.slice(0, count || 10);
}

function findRecentDuplicate(petName, mutation, targetMsRaw, windowMs) {
  const state = load();
  const now = Date.now();
  const needle = (petName || '').trim().toLowerCase();
  const needMut = (mutation || '').trim().toLowerCase();
  const needMs = (targetMsRaw || '').trim().toLowerCase();
  return state.history.find((h) => {
    if (!h.success) return false;
    if (now - h.timestamp > windowMs) return false;
    if ((h.petName || '').trim().toLowerCase() !== needle) return false;
    if ((h.mutation || '').trim().toLowerCase() !== needMut) return false;
    if ((h.targetMsRaw || '').trim().toLowerCase() !== needMs) return false;
    return true;
  });
}

function holdForConfirmation(data) {
  return update((state) => {
    const id = state.nextHoldId++;
    state.holds[id] = { ...data, id, createdAt: Date.now() };
    return id;
  });
}

function getHold(id) { return load().holds[id] || null; }
function listHolds() { return Object.values(load().holds); }

function removeHold(id) {
  return update((state) => {
    const hold = state.holds[id];
    delete state.holds[id];
    return hold || null;
  });
}

function markOfflineAlerted() {
  return update((state) => {
    state.offlineAlerted = true;
  });
}

function wasRecentlyTriggered(key) {
  const state = load();
  const ts = state.stockTriggers[key];
  if (!ts) return false;
  return (Date.now() - ts) < STOCK_DEDUPE_WINDOW_MS;
}

function markTriggered(key) {
  return update((state) => {
    state.stockTriggers[key] = Date.now();
    const cutoff = Date.now() - STOCK_DEDUPE_WINDOW_MS;
    for (const k of Object.keys(state.stockTriggers)) {
      if (state.stockTriggers[k] < cutoff) delete state.stockTriggers[k];
    }
  });
}

function getCustomPetNames() {
  return load().customPetNames || [];
}

function addCustomPetName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return false;
  return update((state) => {
    if (!state.customPetNames) state.customPetNames = [];
    const exists = state.customPetNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
    if (exists) return false;
    state.customPetNames.push(trimmed);
    return true;
  });
}

// ---- Stale-hold reminders (nudges you in Discord if a hold sits too long) ----
function markHoldReminded(id) {
  return update((state) => {
    if (state.holds[id]) {
      state.holds[id].remindedAt = Date.now();
    }
  });
}

function getStaleHolds(staleMs, reminderCooldownMs) {
  const state = load();
  const now = Date.now();
  return Object.values(state.holds).filter((h) => {
    const age = now - h.createdAt;
    if (age < staleMs) return false;
    const lastReminded = h.remindedAt || 0;
    return (now - lastReminded) > reminderCooldownMs;
  });
}
// ── TRADE QUEUE ────────────────────────────────────────────────────

function queueTrade(trade) {
  return update((state) => {
    if (!state.trades) state.trades = [];
    if (!state.tradeHistory) state.tradeHistory = [];
    const entry = {
      id: Date.now().toString(),
      username: trade.username,
      petName: trade.petName,
      mutation: trade.mutation || 'None',
      targetMsRaw: trade.targetMsRaw || '',
      traits: trade.traits || [],
      orderId: trade.orderId || null,
      status: 'pending',
      createdAt: Date.now(),
    };
    state.trades.push(entry);
    return entry;
  });
}

function getPendingTrade() {
  const state = load();
  if (!state.trades) return null;
  return state.trades.find((t) => t.status === 'pending') || null;
}

function resolveTrade(id, result) {
  return update((state) => {
    if (!state.trades) return null;
    if (!state.tradeHistory) state.tradeHistory = [];
    const idx = state.trades.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const trade = state.trades[idx];
    trade.status = result.status; // 'success' | 'failed'
    trade.error = result.error || null;
    trade.resolvedAt = Date.now();
    state.trades.splice(idx, 1);
    state.tradeHistory.unshift(trade);
    if (state.tradeHistory.length > 50) state.tradeHistory.length = 50;
    return trade;
  });
}

function getTradeHistory(count) {
  const state = load();
  return (state.tradeHistory || []).slice(0, count || 10);
}

function cancelPendingTrades() {
  return update((state) => {
    if (!state.trades) return 0;
    const count = state.trades.filter((t) => t.status === 'pending').length;
    state.trades = state.trades.filter((t) => t.status !== 'pending');
    return count;
  });
}

module.exports = {
  enqueue, removeAt, clearQueue, stopNow, setPaused, getStatus, drainDeliverable,
  setLastResult, addHistory, getHistory, findRecentDuplicate,
  holdForConfirmation, getHold, listHolds, removeHold, markOfflineAlerted,
  wasRecentlyTriggered, markTriggered, getCustomPetNames, addCustomPetName,
  markHoldReminded, getStaleHolds, load,queueTrade, getPendingTrade, resolveTrade, getTradeHistory, cancelPendingTrades,
  ackCommand, reapInflight,
};

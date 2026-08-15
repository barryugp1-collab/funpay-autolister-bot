const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'queue-data.json');
const MAX_HISTORY = 50;
const STOCK_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // don't re-trigger the same stock line within 10 min

function defaultState() {
  return {
    queue: [], paused: false, lastPoll: null, lastResult: null, nextId: 1,
    history: [], holds: {}, nextHoldId: 1, offlineAlerted: false,
    stockTriggers: {},
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
    return state;
  } catch (e) {
    return defaultState();
  }
}

function save(state) {
  try { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('Failed to save state:', e); }
}

function enqueue(type, payload) {
  const state = load();
  const cmd = { id: state.nextId++, type, ...payload, createdAt: Date.now() };
  state.queue.push(cmd);
  save(state);
  return cmd;
}

function removeAt(index) {
  const state = load();
  if (index < 0 || index >= state.queue.length) return null;
  const [removed] = state.queue.splice(index, 1);
  save(state);
  return removed;
}

function clearQueue() {
  const state = load();
  state.queue = [];
  save(state);
}

function stopNow() {
  const state = load();
  state.queue = state.queue.filter((c) => !['list', 'bulk', 'confirm_list', 'dryrun', 'stock_check'].includes(c.type));
  state.queue.push({ id: state.nextId++, type: 'stop', createdAt: Date.now() });
  save(state);
}

function setPaused(v) {
  const state = load();
  state.paused = v;
  save(state);
}

function getStatus() { return load(); }

function drainDeliverable() {
  const state = load();
  let deliverable;
  if (state.paused) {
    deliverable = state.queue.filter((c) => c.type === 'stop');
    state.queue = state.queue.filter((c) => c.type !== 'stop');
  } else {
    deliverable = state.queue;
    state.queue = [];
  }
  state.lastPoll = Date.now();
  state.offlineAlerted = false;
  save(state);
  return { paused: state.paused, commands: deliverable };
}

function setLastResult(result) {
  const state = load();
  state.lastResult = { ...result, receivedAt: Date.now() };
  save(state);
}

function addHistory(entry) {
  const state = load();
  state.history.unshift({ ...entry, timestamp: Date.now() });
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  save(state);
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
  const state = load();
  const id = state.nextHoldId++;
  state.holds[id] = { ...data, id, createdAt: Date.now() };
  save(state);
  return id;
}

function getHold(id) { return load().holds[id] || null; }
function listHolds() { return Object.values(load().holds); }

function removeHold(id) {
  const state = load();
  const hold = state.holds[id];
  delete state.holds[id];
  save(state);
  return hold || null;
}

function markOfflineAlerted() {
  const state = load();
  state.offlineAlerted = true;
  save(state);
}

// ---- Stock-feed dedupe (prevents re-triggering a hold every time the
// same Captain Hook stock line reappears within the window) ----
function wasRecentlyTriggered(key) {
  const state = load();
  const ts = state.stockTriggers[key];
  if (!ts) return false;
  return (Date.now() - ts) < STOCK_DEDUPE_WINDOW_MS;
}

function markTriggered(key) {
  const state = load();
  state.stockTriggers[key] = Date.now();
  // prune old entries so this doesn't grow forever
  const cutoff = Date.now() - STOCK_DEDUPE_WINDOW_MS;
  for (const k of Object.keys(state.stockTriggers)) {
    if (state.stockTriggers[k] < cutoff) delete state.stockTriggers[k];
  }
  save(state);
}

module.exports = {
  enqueue, removeAt, clearQueue, stopNow, setPaused, getStatus, drainDeliverable,
  setLastResult, addHistory, getHistory, findRecentDuplicate,
  holdForConfirmation, getHold, listHolds, removeHold, markOfflineAlerted,
  wasRecentlyTriggered, markTriggered, load,
};

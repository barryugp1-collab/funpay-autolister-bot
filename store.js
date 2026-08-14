const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'queue-data.json');

function defaultState() {
  return { queue: [], paused: false, lastPoll: null, lastResult: null, nextId: 1 };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return defaultState();
  }
}

function save(state) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

function enqueue(type, payload) {
  const state = load();
  const cmd = { id: state.nextId++, type, ...payload, createdAt: Date.now() };
  state.queue.push(cmd);
  save(state);
  return cmd;
}

function clearQueue() {
  const state = load();
  state.queue = [];
  save(state);
}

// /stop clears any not-yet-delivered list/bulk work AND pushes a 'stop'
// command so an item the userscript is actively mid-way through also halts.
function stopNow() {
  const state = load();
  state.queue = state.queue.filter((c) => c.type !== 'list' && c.type !== 'bulk');
  state.queue.push({ id: state.nextId++, type: 'stop', createdAt: Date.now() });
  save(state);
}

function setPaused(v) {
  const state = load();
  state.paused = v;
  save(state);
}

function getStatus() {
  return load();
}

// Called when the userscript polls. While paused, 'stop' commands still get
// delivered immediately, but 'list'/'bulk' stay queued until /resume.
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
  save(state);
  return { paused: state.paused, commands: deliverable };
}

function setLastResult(result) {
  const state = load();
  state.lastResult = { ...result, receivedAt: Date.now() };
  save(state);
}

module.exports = {
  enqueue, clearQueue, stopNow, setPaused, getStatus, drainDeliverable, setLastResult, load,
};

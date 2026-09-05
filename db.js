// db.js — production-ready persistence layer.
// Uses PostgreSQL when DATABASE_URL is configured (Render), while keeping the
// synchronous API expected by the rest of the app. When the database is not
// configured, this falls back to the local JSON file for local development.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const DEFAULT_ADMIN_HASH = '$2b$10$9zSDcqPAqbTNIwtkKxnSveBIdvHw9MJDj/g/eTgkJFucAW9xOiG4u';
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

let cache = null;
let initialized = false;

function makeDefaultState() {
  const now = new Date().toISOString();
  return {
    meta: { lastUpdatedAt: now },
    admin: { username: 'admin', passwordHash: DEFAULT_ADMIN_HASH },
    towers: [
      { id: 1, name: 'Tower 1', codename: 'Beacon', accent: '#E8A33D', tagline: 'North Wing', layout: 'cards' },
      { id: 2, name: 'Tower 2', codename: 'Signal', accent: '#2FB8A6', tagline: 'East Wing', layout: 'timeline' },
      { id: 3, name: 'Tower 3', codename: 'Rebar', accent: '#D64545', tagline: 'South Wing', layout: 'ledger' },
      { id: 4, name: 'Tower 4', codename: 'Site', accent: '#8B6FD9', tagline: 'West Wing', layout: 'cards' },
      { id: 5, name: 'Tower 5', codename: 'Concrete', accent: '#4C7EA8', tagline: 'Central Wing', layout: 'ledger' },
      { id: 6, name: 'Tower 6', codename: 'Moss', accent: '#6B9B4F', tagline: 'Garden Wing', layout: 'timeline' }
    ],
    threads: [],
    nextThreadSeq: 1,
    adminUsers: [{ username: 'admin', role: 'admin', passwordHash: DEFAULT_ADMIN_HASH }],
    notifications: [],
    maintenance: [],
    auditLog: [],
    publicSettings: { showOpenConcerns: true, allowAnonymousReports: true }
  };
}

function ensureDbDirectory() {
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeAdminState(state) {
  const base = makeDefaultState();
  const adminName = state?.admin?.username || state?.adminUsers?.find(user => user.username === 'admin')?.username || 'admin';
  const adminHash = state?.admin?.passwordHash || state?.adminUsers?.find(user => user.username === adminName)?.passwordHash || base.admin.passwordHash;
  state.admin = { username: adminName, passwordHash: adminHash };
  const sanitizedUsers = Array.isArray(state.adminUsers) ? state.adminUsers.filter(user => user.username !== adminName) : [];
  sanitizedUsers.unshift({ username: adminName, role: 'admin', passwordHash: adminHash });
  state.adminUsers = sanitizedUsers;
  return state;
}

function stateUpdatedAt(state) {
  if (!state || typeof state !== 'object') return 0;
  const candidates = [];
  if (state.meta && state.meta.lastUpdatedAt) candidates.push(new Date(state.meta.lastUpdatedAt).getTime());
  if (Array.isArray(state.threads)) {
    state.threads.forEach(thread => {
      if (thread && thread.updatedAt) candidates.push(new Date(thread.updatedAt).getTime());
    });
  }
  if (Array.isArray(state.notifications)) {
    state.notifications.forEach(item => {
      if (item && item.createdAt) candidates.push(new Date(item.createdAt).getTime());
    });
  }
  if (Array.isArray(state.maintenance)) {
    state.maintenance.forEach(item => {
      if (item && item.createdAt) candidates.push(new Date(item.createdAt).getTime());
    });
  }
  return candidates.length ? Math.max(...candidates) : 0;
}

function stampLatestState(state) {
  if (!state || typeof state !== 'object') return state;
  state.meta = state.meta || {};
  state.meta.lastUpdatedAt = new Date(stateUpdatedAt(state) || Date.now()).toISOString();
  return state;
}

function chooseLatestState(a, b) {
  if (!a) return b;
  if (!b) return a;
  return stateUpdatedAt(a) >= stateUpdatedAt(b) ? a : b;
}

function mergeState(candidate) {
  const base = makeDefaultState();
  const parsed = candidate && typeof candidate === 'object' ? candidate : {};
  const merged = {
    ...base,
    ...parsed,
    meta: { ...(base.meta || {}), ...(parsed.meta || {}) },
    admin: { ...base.admin, ...(parsed.admin || {}) },
    towers: Array.isArray(parsed.towers) && parsed.towers.length ? parsed.towers : base.towers,
    threads: Array.isArray(parsed.threads) ? parsed.threads : base.threads,
    nextThreadSeq: Number.isInteger(parsed.nextThreadSeq) ? parsed.nextThreadSeq : base.nextThreadSeq,
    adminUsers: Array.isArray(parsed.adminUsers) && parsed.adminUsers.length ? parsed.adminUsers : base.adminUsers,
    notifications: Array.isArray(parsed.notifications) ? parsed.notifications : base.notifications,
    maintenance: Array.isArray(parsed.maintenance) ? parsed.maintenance : base.maintenance,
    auditLog: Array.isArray(parsed.auditLog) ? parsed.auditLog : base.auditLog,
    publicSettings: { ...base.publicSettings, ...(parsed.publicSettings || {}) }
  };
  return stampLatestState(normalizeAdminState(merged));
}

function loadFromJson() {
  ensureDbDirectory();

  if (!fs.existsSync(DB_PATH)) {
    const fallback = makeDefaultState();
    saveToJson(fallback);
    return fallback;
  }

  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8').trim();
    if (!raw) {
      const fallback = makeDefaultState();
      saveToJson(fallback);
      return fallback;
    }

    const parsed = JSON.parse(raw);
    const merged = mergeState(parsed);
    if (JSON.stringify(merged) !== raw) {
      saveToJson(merged);
    }
    return merged;
  } catch (error) {
    console.warn('Database was unreadable; reset to a safe default state.', error.message);
    const fallback = makeDefaultState();
    saveToJson(fallback);
    return fallback;
  }
}

function saveToJson(state) {
  ensureDbDirectory();
  if (!state || typeof state !== 'object') return;
  const snapshot = stampLatestState(JSON.parse(JSON.stringify(state)));
  fs.writeFileSync(DB_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
}

async function ensureDatabaseSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function loadFromDatabase() {
  if (!pool) return loadFromJson();
  await ensureDatabaseSchema();
  const result = await pool.query('SELECT value FROM app_state WHERE key = $1 LIMIT 1', ['app']);
  if (result.rows.length === 0) {
    const fallback = makeDefaultState();
    await saveToDatabase(fallback);
    return fallback;
  }
  return mergeState(result.rows[0].value);
}

async function saveToDatabase(state) {
  if (!pool) {
    saveToJson(state);
    return;
  }
  await ensureDatabaseSchema();
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    ['app', state]
  );
}

async function initialize() {
  if (initialized) return cache;

  let dbState = null;
  let jsonState = null;

  if (DATABASE_URL && pool) {
    try {
      dbState = await loadFromDatabase();
    } catch (error) {
      console.warn('Postgres init failed; falling back to JSON state.', error.message);
    }
  }

  jsonState = loadFromJson();
  cache = chooseLatestState(dbState, jsonState);

  initialized = true;
  return cache;
}

async function safeDatabaseOperation(operation, fallback) {
  if (!DATABASE_URL || !pool) return fallback();
  try {
    return await operation();
  } catch (error) {
    console.warn('Database operation failed; using fallback state.', error.message);
    const jsonState = loadFromJson();
    if (typeof fallback === 'function') return fallback(jsonState);
    return jsonState;
  }
}

function load() {
  if (!cache) {
    cache = loadFromJson();
  }
  return cache;
}

async function save(state) {
  const current = stampLatestState(state || cache || makeDefaultState());
  cache = current;

  // Always persist the JSON snapshot first so a restart can recover the latest
  // state even if the database layer is slow, unavailable, or still warming up.
  saveToJson(current);

  if (DATABASE_URL && pool) {
    try {
      await saveToDatabase(current);
    } catch (error) {
      console.warn('Database sync failed; JSON snapshot remains authoritative.', error.message);
    }
  }

  return current;
}

let queue = Promise.resolve();
function update(mutator) {
  queue = queue.then(async () => {
    let current = cache;
    try {
      current = chooseLatestState(current, await initialize());
    } catch (error) {
      console.warn('Initialize failed; using JSON fallback.', error.message);
      current = chooseLatestState(current, loadFromJson());
    }

    const result = mutator(current);
    if (result && result.error) {
      return result;
    }
    await save(current);
    return result;
  });
  return queue;
}

module.exports = { load, save, update, initialize, makeDefaultState };

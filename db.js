// db.js — tiny file-backed data store.
// Not built for concurrent scale, but perfectly fine for a single-instance
// prototype / small deployment. Reads and writes to data/db.json.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function load() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

// Simple in-process write queue so two quick requests can't clobber
// each other's writes.
let queue = Promise.resolve();
function update(mutator) {
  queue = queue.then(() => {
    const db = load();
    const result = mutator(db);
    save(db);
    return result;
  });
  return queue;
}

module.exports = { load, save, update };

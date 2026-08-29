const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../server');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('serves the main application pages', async () => {
  for (const page of ['/', '/index.html', '/tower.html?id=1', '/thread.html?token=kf4c2wknm2', '/admin.html']) {
    const response = await fetch(baseUrl + page);
    assert.equal(response.status, 200, page);
  }
});

test('uses the documented default admin password', async () => {
  const { load } = require('../db');
  const state = load();
  const bcrypt = require('bcryptjs');
  assert.equal(state.admin.username, 'admin');
  assert.equal(bcrypt.compareSync('admin123', state.admin.passwordHash), true);
});

test('protects admin analytics and private documents', async () => {
  const analytics = await fetch(`${baseUrl}/api/admin/analytics`);
  const document = await fetch(`${baseUrl}/api/admin/threads/kf4c2wknm2/verification/document`);
  assert.equal(analytics.status, 401);
  assert.equal(document.status, 401);
});

test('does not expose pending feedback or stale image URLs publicly', async () => {
  const response = await fetch(`${baseUrl}/api/threads/kf4c2wknm2`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(data.thread, 'pendingFeedback'), false);
  assert.equal(data.thread.messages.some(message => message.attachment && message.attachment.includes('8c938bb1')), false);
});

test('blocks the retired resident reply bypass', async () => {
  const response = await fetch(`${baseUrl}/api/threads/kf4c2wknm2/reply`, { method: 'POST' });
  assert.equal(response.status, 410);
});

test('allows a fresh verification submission while the concern remains open', async () => {
  const token = 'kf4c2wknm2';
  const form = new FormData();
  form.append('fullName', 'Repeat Verification User');
  form.append('documentType', 'Building ID');
  form.append('idNumber', 'ABC123');
  form.append('message', 'This is a new verification attempt while the concern is still open.');
  form.append('idDocument', new Blob(['%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'], { type: 'application/pdf' }), 'repeat-id.pdf');

  const response = await fetch(`${baseUrl}/api/threads/${token}/verification`, {
    method: 'POST',
    body: form
  });

  assert.equal(response.status, 201, 'should accept fresh verification while thread is open');
  const data = await response.json();
  assert.equal(data.status, 'pending');
});

test('bootstraps a safe default state if the database file is missing or empty', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dbFile = path.join(__dirname, '..', 'data', 'db.json');
  const original = fs.readFileSync(dbFile, 'utf8');

  try {
    fs.writeFileSync(dbFile, '');
    const { load } = require('../db');
    const state = load();
    assert.ok(state && Array.isArray(state.threads));
    assert.ok(state.admin && state.admin.username === 'admin');
    assert.ok(Array.isArray(state.towers) && state.towers.length > 0);
  } finally {
    fs.writeFileSync(dbFile, original);
    delete require.cache[require.resolve('../db')];
  }
});

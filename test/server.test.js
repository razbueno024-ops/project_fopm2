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

test('keeps the user-view action in the header and out of the settings menu', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(html, /id="userViewBtn"/i, 'admin dashboard header must expose a user-view trigger');
  assert.doesNotMatch(html, /data-action="user-view"/i, 'admin dropdown should not include the public user-view action');
  assert.doesNotMatch(html, /data-action="password"/i, 'admin dropdown should not include the password action');
});

test('excludes resolved concerns from tower and public feed APIs', async () => {
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();

  const towerResponse = await fetch(`${baseUrl}/api/towers/1/threads`, {
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(towerResponse.status, 200);
  const threads = await towerResponse.json();
  assert.ok(Array.isArray(threads));
  assert.ok(threads.every(thread => thread.status !== 'resolved' && thread.status !== 'satisfied'));

  const createResponse = await fetch(`${baseUrl}/api/admin/towers/1/threads`, {
    method: 'POST',
    headers: { 'X-FOPM-Admin-Token': token },
    body: new URLSearchParams({
      title: 'Temporary resolved regression test',
      message: 'This thread should be filtered into the resolved bucket only.',
      category: 'General',
      urgency: 'normal',
      location: 'Regression test lane'
    })
  });
  assert.equal(createResponse.status, 201, 'admin should be able to create a test concern');
  const created = await createResponse.json();
  assert.ok(created.token, 'created thread should have a token');

  const closeResponse = await fetch(`${baseUrl}/api/admin/threads/${created.token}/close`, {
    method: 'POST',
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(closeResponse.status, 200, 'admin should be able to close a concern');

  const adminList = await fetch(`${baseUrl}/api/admin/threads`, {
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(adminList.status, 200);
  const adminThreads = await adminList.json();
  assert.ok(adminThreads.every(thread => thread.status !== 'resolved'));

  const resolvedList = await fetch(`${baseUrl}/api/admin/threads?status=resolved`, {
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(resolvedList.status, 200);
  const resolvedThreads = await resolvedList.json();
  assert.ok(Array.isArray(resolvedThreads));
  assert.ok(resolvedThreads.some(thread => thread.token === created.token && thread.status === 'resolved'));

  const allTowersResponse = await fetch(`${baseUrl}/api/towers`);
  assert.equal(allTowersResponse.status, 200);
  const towers = await allTowersResponse.json();
  assert.ok(towers.every(tower => tower.openThreads >= 0));
});

test('uses the documented default admin password', async () => {
  const { load } = require('../db');
  const state = load();
  const bcrypt = require('bcryptjs');
  assert.equal(state.admin.username, 'admin');
  assert.equal(bcrypt.compareSync('admin123', state.admin.passwordHash), true);
});

test('repairs stale adminUsers hashes before login checks', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dbFile = path.join(__dirname, '..', 'data', 'db.json');
  const original = fs.readFileSync(dbFile, 'utf8');

  try {
    const stale = JSON.parse(original);
    stale.admin.passwordHash = stale.admin.passwordHash;
    stale.adminUsers = [{ username: 'admin', role: 'admin', passwordHash: '$2b$10$wronghashINVALID0000000000000000000000000' }];
    fs.writeFileSync(dbFile, JSON.stringify(stale, null, 2));
    delete require.cache[require.resolve('../db')];

    const { load } = require('../db');
    const state = load();
    assert.equal(state.adminUsers[0].username, 'admin');
    assert.equal(state.adminUsers[0].passwordHash, state.admin.passwordHash);
  } finally {
    fs.writeFileSync(dbFile, original);
    delete require.cache[require.resolve('../db')];
  }
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

test('exposes unread and new-verification metadata for the admin board', async () => {
  const cookieJar = new Map();
  const request = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    const cookieHeader = Array.from(cookieJar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookieHeader) headers.set('Cookie', cookieHeader);
    const response = await fetch(url, { ...options, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const cookie = setCookie.split(';')[0];
      const [name, value] = cookie.split('=');
      cookieJar.set(name, value);
    }
    return response;
  };

  const login = await request(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.equal(login.status, 200, 'admin login should succeed');
  const loginBody = await login.json();
  assert.ok(loginBody.token, 'login should return a browser-safe admin token');

  const response = await request(`${baseUrl}/api/admin/threads`, {
    headers: { 'X-FOPM-Admin-Token': loginBody.token }
  });
  assert.equal(response.status, 200);
  const threads = await response.json();
  assert.ok(Array.isArray(threads));
  assert.ok(threads.every(thread => typeof thread.unreadCount === 'number'));
  assert.ok(threads.every(thread => typeof thread.hasNewVerification === 'boolean'));
});

test('revokes an admin token when the user logs out', async () => {
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();
  assert.ok(token, 'login should issue an admin token');

  const logout = await fetch(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(logout.status, 200, 'logout should succeed');

  const session = await fetch(`${baseUrl}/api/admin/session`, {
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(session.status, 200);
  const payload = await session.json();
  assert.equal(payload.isAdmin, false, 'revoked token should not keep admin access');
});

test('marks alert notifications as read and keeps the unread badge clear after reload', { concurrency: false }, async () => {
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();

  const clear = await fetch(`${baseUrl}/api/admin/notifications/clear`, {
    method: 'POST',
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(clear.status, 200, 'notification list should be clearable before the regression test');

  const form = new FormData();
  form.append('fullName', 'Notification Read User');
  form.append('documentType', 'Resident card');
  form.append('idNumber', 'NR-1001');
  form.append('message', 'This verification should create a notification for the admin panel.');
  form.append('idDocument', new Blob(['%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'], { type: 'application/pdf' }), 'notification-read.pdf');

  const verification = await fetch(`${baseUrl}/api/threads/kf4c2wknm2/verification`, {
    method: 'POST',
    body: form
  });
  assert.equal(verification.status, 201, 'verification submission should create a notification');

  const list = await fetch(`${baseUrl}/api/admin/notifications`, {
    headers: { 'X-FOPM-Admin-Token': token }
  });
  const items = await list.json();
  const notification = items.find(item => item.type === 'verification' && item.threadToken === 'kf4c2wknm2');
  assert.ok(notification, 'verification should create an alert notification');

  const readResponse = await fetch(`${baseUrl}/api/admin/notifications/${notification.id}/read`, {
    method: 'POST',
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(readResponse.status, 200, 'notification read endpoint should succeed');

  const refreshed = await fetch(`${baseUrl}/api/admin/notifications`, {
    headers: { 'X-FOPM-Admin-Token': token }
  });
  const updated = await refreshed.json();
  const savedNotification = updated.find(item => item.id === notification.id);
  assert.equal(savedNotification.read, true, 'notification should be persisted as read');
  assert.equal(updated.filter(item => !item.read).length, 0, 'unread alert count should be zero after reading');
});

test('allows the admin to clear all notifications', { concurrency: false }, async () => {
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();

  const response = await fetch(`${baseUrl}/api/admin/notifications/clear`, {
    method: 'POST',
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(response.status, 200, 'notifications should clear successfully');

  const list = await fetch(`${baseUrl}/api/admin/notifications`, {
    headers: { 'X-FOPM-Admin-Token': token }
  });
  const items = await list.json();
  assert.deepEqual(items, [], 'notification list should be empty after clearing');
});

test('shows deleted concerns in the admin deleted filter so they can be recovered', async () => {
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const { token } = await login.json();
  const uniqueTitle = `T-ALPHA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const createResponse = await fetch(`${baseUrl}/api/admin/towers/1/threads`, {
    method: 'POST',
    headers: { 'X-FOPM-Admin-Token': token },
    body: new URLSearchParams({
      title: uniqueTitle,
      message: 'This concern should appear in the deleted view and be recoverable.',
      category: 'General',
      urgency: 'normal',
      location: 'Deleted filter test'
    })
  });
  assert.equal(createResponse.status, 201, 'admin should create a concern for deletion testing');
  const created = await createResponse.json();

  const deleteResponse = await fetch(`${baseUrl}/api/admin/threads/${created.token}`, {
    method: 'DELETE',
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(deleteResponse.status, 200, 'soft-deleted concerns should be deletable');

  const deletedList = await fetch(`${baseUrl}/api/admin/threads?status=deleted`, {
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(deletedList.status, 200, 'deleted filter endpoint should be available');
  const deletedThreads = await deletedList.json();
  assert.ok(deletedThreads.some(thread => thread.token === created.token), 'deleted concern should appear in the deleted filter');

  const recoverResponse = await fetch(`${baseUrl}/api/admin/threads/${created.token}/recover`, {
    method: 'POST',
    headers: { 'X-FOPM-Admin-Token': token }
  });
  assert.equal(recoverResponse.status, 200, 'recover endpoint should restore the deleted concern');
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

test('falls back to the JSON store if PostgreSQL is unavailable', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dbFile = path.join(__dirname, '..', 'data', 'db.json');
  const original = fs.readFileSync(dbFile, 'utf8');
  const pg = require('pg');
  const originalPool = pg.Pool;

  try {
    pg.Pool = class {
      constructor() {
        this.query = async () => {
          throw new Error('database unavailable');
        };
      }
    };
    delete require.cache[require.resolve('../db')];
    const db = require('../db');
    fs.writeFileSync(dbFile, JSON.stringify({ admin: { username: 'admin', passwordHash: '$2b$10$9zSDcqPAqbTNIwtkKxnSveBIdvHw9MJDj/g/eTgkJFucAW9xOiG4u' }, towers: [], threads: [], nextThreadSeq: 1, adminUsers: [{ username: 'admin', role: 'admin', passwordHash: '$2b$10$9zSDcqPAqbTNIwtkKxnSveBIdvHw9MJDj/g/eTgkJFucAW9xOiG4u' }], notifications: [], maintenance: [] }, null, 2));

    await db.update(state => {
      state.threads.push({ token: 'fallback-test', title: 'Fallback thread', status: 'new', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), towerId: 1, messages: [], category: 'General', urgency: 'normal', location: '', history: [] });
      return { ok: true };
    });

    const state = db.load();
    assert.ok(Array.isArray(state.threads));
    assert.ok(state.threads.some(thread => thread.token === 'fallback-test'));
  } finally {
    pg.Pool = originalPool;
    fs.writeFileSync(dbFile, original);
    delete require.cache[require.resolve('../db')];
  }
});

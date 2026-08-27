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

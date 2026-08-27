// api.js — small shared helpers used across every page.

async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function apiSend(url, method, body, isForm) {
  const opts = { method, headers: {} };
  if (isForm) {
    opts.body = body;
  } else {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

const apiPost = (url, body, isForm) => apiSend(url, 'POST', body, isForm);
const apiPatch = (url, body) => apiSend(url, 'PATCH', body, false);
const apiDelete = (url) => apiSend(url, 'DELETE', null, false);

function toast(message, isError) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function initials(name) {
  const n = (name || '?').trim();
  return n ? n[0].toUpperCase() : '?';
}

function setTowerTheme(accentHex) {
  document.documentElement.style.setProperty('--tower-accent', accentHex);
}

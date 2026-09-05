// admin.js — powers the admin dashboard: navigation, notifications,
// thread detail, and the admin-only moderation actions.

let currentFilter = { towerId: null, status: null, label: 'All towers' };
let towersCache = [];
let searchTerm = '';
let currentRole = 'admin';
let lastNotificationCount = 0;
let lastNotificationId = null;
let adminPollHandle = null;
const statusLabels = { new: 'New', 'in-progress': 'In progress', resolved: 'Resolved', open: 'Open', satisfied: 'Resolved' };

function notifyNewActivity(message, type = 'concern') {
  const kind = (type || 'concern').toLowerCase();
  const prefix = kind === 'verification' ? 'Verification update' : 'New concern update';
  toast(`${prefix}: ${message}`, false);
}

function setSaveState(message, isError = false) {
  const pill = document.getElementById('saveStatusPill');
  if (!pill) return;
  pill.textContent = message;
  pill.classList.toggle('error', !!isError);
  pill.classList.add('show');
  clearTimeout(pill._timer);
  pill._timer = setTimeout(() => pill.classList.remove('show'), 2200);
}

function keywordScore(title, query, extras = []) {
  const haystack = [title, ...extras].filter(Boolean).join(' ').toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;
  if (haystack === normalizedQuery) return 1000;
  if (haystack.includes(normalizedQuery)) return 800;
  return normalizedQuery.split(/\s+/).reduce((score, word) => {
    if (haystack.includes(word)) return score + 100;
    return score;
  }, 0);
}

async function guard() {
  const s = await apiGet('/api/admin/session');
  if (!s.isAdmin) { location.href = '/admin-login.html'; throw new Error('redirect'); }
  currentRole = s.role || 'admin';
}

async function renderSidebar() {
  towersCache = await apiGet('/api/admin/towers');
  const totalUnread = towersCache.reduce((a, t) => a + t.unread, 0);
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = `
    <div class="sidebar-item ${!currentFilter.towerId ? 'active' : ''}" data-tower="" data-status="">
      <span>All towers</span>
      ${totalUnread ? `<span class="badge badge-notify">${totalUnread}</span>` : ''}
    </div>
    <div class="sidebar-section-title">Towers</div>
    ${towersCache.map(t => `
      <div class="sidebar-item ${String(currentFilter.towerId) === String(t.id) ? 'active' : ''}" style="--tower-accent:${t.accent}" data-tower="${t.id}" data-status="">
        <span>${t.name} <span class="mono" style="color:var(--text-faint); font-size:.75em;">${t.codename}</span></span>
        ${t.unread ? `<span class="badge badge-notify">${t.unread}</span>` : ''}
      </div>
    `).join('')}
    <div class="sidebar-section-title">Filter</div>
    <div class="sidebar-item ${currentFilter.status === 'new' ? 'active' : ''}" data-tower="${currentFilter.towerId || ''}" data-status="new"><span>New</span></div>
    <div class="sidebar-item ${currentFilter.status === 'in-progress' ? 'active' : ''}" data-tower="${currentFilter.towerId || ''}" data-status="in-progress"><span>In progress</span></div>
    <div class="sidebar-item ${currentFilter.status === 'resolved' ? 'active' : ''}" data-tower="${currentFilter.towerId || ''}" data-status="resolved"><span>Resolved</span></div>
    <div class="sidebar-item ${currentFilter.status === 'deleted' ? 'active' : ''}" data-tower="${currentFilter.towerId || ''}" data-status="deleted"><span>Deleted</span></div>
  `;
  sidebar.querySelectorAll('.sidebar-item').forEach(el => {
    el.onclick = () => {
      currentFilter.towerId = el.dataset.tower || null;
      currentFilter.status = el.dataset.status || null;
      renderSidebar();
      renderThreadList();
    };
  });
}

async function renderThreadList() {
  const qs = new URLSearchParams();
  if (currentFilter.towerId) qs.set('towerId', currentFilter.towerId);
  if (currentFilter.status) qs.set('status', currentFilter.status);
  let threads = await apiGet(`/api/admin/threads?${qs.toString()}`);
  const query = searchTerm.trim();
  if (query) {
    threads = threads
      .map(thread => ({ thread, score: keywordScore(thread.title, query, [thread.submitterName, thread.submitterUnit, thread.category, thread.location, thread.assignedTo, statusLabels[thread.status] || '']) }))
      .filter(result => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .map(result => result.thread);
  }
  const main = document.getElementById('main');

  if (!threads.length) {
    main.innerHTML = `<div class="thread-header"><h2 style="font-size:1.3rem;">Concerns</h2></div><div class="toolbar-box"><input class="admin-search" id="threadSearch" placeholder="Search by title, resident, staff, category, or location..." value="${escapeHtml(searchTerm)}"></div><div class="empty-state"><div class="glyph">📭</div>No concerns match this search or filter.</div>`;
    wireThreadSearch();
    return;
  }

  main.innerHTML = `
    <div class="thread-header">
      <h2 style="font-size:1.3rem;">Concerns</h2>
    </div>
    <div class="toolbar-box">
      <input class="admin-search" id="threadSearch" placeholder="Search by title, resident, staff, category, or location..." value="${escapeHtml(searchTerm)}">
    </div>
    <div class="thread-list">
      ${threads.map(t => {
        const tower = towersCache.find(tw => tw.id === t.towerId) || {};
        const unreadCount = Number(t.unreadCount || 0);
        const isNewVerification = !!t.hasNewVerification;
        const isDeleted = !!t.deleted;
        return `
        <div class="thread-row fade-in ${isNewVerification ? 'thread-row--alert' : ''}" style="--tower-accent:${tower.accent || '#4C7EA8'}" data-token="${t.token}">
          <div class="thread-row-main">
            <div class="title-row">
              <div class="title">${escapeHtml(t.title)}</div>
              ${unreadCount ? `<span class="badge badge-notify thread-unread-badge" aria-label="${unreadCount} unread messages">${unreadCount}</span>` : ''}
              ${isNewVerification ? `<span class="badge badge-alert" aria-label="New verification pending">New verification</span>` : ''}
            </div>
            <div class="thread-meta">
              <span>${tower.name || 'Tower'}</span>
              <span>${escapeHtml(t.submitterName || 'Anonymous')}${t.submitterUnit ? ' · ' + escapeHtml(t.submitterUnit) : ''}</span>
              <span>${escapeHtml(t.category || 'General')}</span>
              <span>${t.messages.length} message${t.messages.length===1?'':'s'}</span>
              <span>updated ${timeAgo(t.updatedAt)}</span>
            </div>
          </div>
          <div class="thread-row-actions">
            <span class="badge ${isDeleted ? 'badge-alert' : (t.status==='resolved'?'badge-satisfied':'badge-open')}"><span class="badge-dot"></span>${isDeleted ? 'Deleted' : (statusLabels[t.status] || 'New')}</span>
            ${isDeleted ? `<button class="thread-read-toggle" type="button" data-token="${t.token}" data-action="recover">Recover</button>` : `<button class="thread-read-toggle" type="button" data-token="${t.token}" data-unread="${t.adminUnread ? 'true' : 'false'}">${t.adminUnread ? 'Mark read' : 'Mark unread'}</button>`}
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
  main.querySelectorAll('.thread-row').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = (event) => {
      if (!event.target.closest('.thread-read-toggle')) {
        renderThreadDetail(el.dataset.token);
      }
    };
  });
  main.querySelectorAll('.thread-read-toggle').forEach(btn => {
    btn.onclick = async (event) => {
      event.stopPropagation();
      const token = btn.dataset.token;
      if (btn.dataset.action === 'recover') {
        await apiPost(`/api/admin/threads/${token}/recover`);
        setSaveState('Thread recovered');
        renderSidebar();
        renderThreadList();
        renderNotificationPanel();
        return;
      }
      const unread = btn.dataset.unread === 'true';
      await apiPost(`/api/admin/threads/${token}/${unread ? 'read' : 'unread'}`);
      setSaveState(unread ? 'Marked read' : 'Marked unread');
      renderSidebar();
      renderThreadList();
      renderNotificationPanel();
    };
  });
  wireThreadSearch();
}

function wireThreadSearch() {
  const input = document.getElementById('threadSearch');
  if (!input) return;
  input.oninput = () => {
    searchTerm = input.value;
    const caretPosition = input.selectionStart;
    renderThreadList().then(() => {
      const nextInput = document.getElementById('threadSearch');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(caretPosition, caretPosition);
      }
    });
  };
}

function bindPasswordVisibility(root = document) {
  root.querySelectorAll('.password-toggle').forEach(button => {
    const input = root.getElementById(button.dataset.targetId);
    if (!input) return;
    button.addEventListener('click', () => {
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      button.textContent = visible ? 'Show' : 'Hide';
      button.setAttribute('aria-pressed', String(!visible));
    });
  });
}

function renderCreateForm() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="eyebrow">Admin action</div><h2 style="font-size:1.3rem;">Create a concern</h2><form class="card" id="createForm" style="max-width:680px;"><div class="field"><label for="createTower">Tower</label><select id="createTower" required>${towersCache.map(t => `<option value="${t.id}">${escapeHtml(t.name)} · ${escapeHtml(t.codename)}</option>`).join('')}</select></div><div class="field"><label for="createTitle">Concern title</label><input id="createTitle" required maxlength="140"></div><div class="field"><label for="createMessage">Concern details</label><textarea id="createMessage" required></textarea></div><div class="field"><label for="createCategory">Category</label><select id="createCategory"><option>General</option><option>Maintenance</option><option>Safety</option><option>Noise</option><option>Cleanliness</option><option>Facilities</option></select></div><div class="field"><label for="createUrgency">Urgency</label><select id="createUrgency"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="emergency">Emergency</option></select></div><div class="field"><label for="createLocation">Location</label><input id="createLocation" maxlength="120"></div><div class="field"><label>Photo attachment (optional)</label><input type="file" id="createFile" accept="image/*"></div><div style="display:flex;gap:10px;"><button class="btn btn-primary" type="submit">Create concern</button><button class="btn btn-ghost" type="button" id="cancelCreate">Cancel</button></div></form>`;
  document.getElementById('cancelCreate').onclick = renderThreadList;
  document.getElementById('createForm').onsubmit = async event => {
    event.preventDefault();
    const formData = new FormData();
    ['title', 'message', 'category', 'urgency', 'location'].forEach(name => formData.append(name, document.getElementById(`create${name[0].toUpperCase()}${name.slice(1)}`).value));
    if (document.getElementById('createFile').files[0]) formData.append('attachment', document.getElementById('createFile').files[0]);
    try { const result = await apiPost(`/api/admin/towers/${document.getElementById('createTower').value}/threads`, formData, true); toast('Concern created.'); renderThreadDetail(result.token); }
    catch (error) { toast(error.message, true); }
  };
}

async function renderAnalytics() {
  const data = await apiGet('/api/admin/analytics');
  document.getElementById('main').innerHTML = `<div class="eyebrow">Operations overview</div><h2>Analytics</h2><div class="analytics-grid"><div class="card"><strong>${data.total}</strong><span>Total concerns</span></div><div class="card"><strong>${data.averageResolutionHours}h</strong><span>Average resolution</span></div><div class="card"><strong>${data.emergencyOpen || 0}</strong><span>Open emergencies</span></div></div><div class="card"><h3>By category</h3>${Object.entries(data.byCategory).map(([key, value]) => `<div class="analytics-row"><span>${escapeHtml(key)}</span><strong>${value}</strong></div>`).join('')}</div><div class="card" style="margin-top:16px;"><h3>By urgency</h3>${Object.entries(data.byUrgency || {}).map(([key, value]) => `<div class="analytics-row"><span>${escapeHtml(key)}</span><strong>${value}</strong></div>`).join('')}</div>`;
}

async function renderAuditLog() {
  const entries = await apiGet('/api/admin/audit-log');
  document.getElementById('main').innerHTML = `<div class="eyebrow">Accountability</div><h2>Audit log</h2><div class="card"><div class="thread-list">${entries.length ? entries.map(entry => `<div class="analytics-row"><strong>${escapeHtml(entry.action)}</strong><span>${escapeHtml(entry.by || 'System')} · ${timeAgo(entry.at)}</span></div>`).join('') : '<div class="empty-state">No audit events yet.</div>'}</div></div>`;
}

async function renderUsers() {
  const users = await apiGet('/api/admin/users');
  document.getElementById('main').innerHTML = `<div class="eyebrow">Access control</div><h2>Admin users</h2><div class="card"><div class="thread-list">${users.map(user => `<div class="analytics-row" style="display:flex; justify-content:space-between; gap:12px; align-items:center;"><div><span>${escapeHtml(user.username)}</span><strong style="margin-left:10px;">${escapeHtml(user.role)}</strong></div><div style="display:flex; gap:8px; flex-wrap:wrap;"><button class="btn btn-ghost btn-sm" data-edit-password-user="${escapeHtml(user.username)}" type="button">Change password</button><button class="btn btn-danger btn-sm" data-delete-user="${escapeHtml(user.username)}" type="button">Terminate</button></div></div>`).join('')}</div><form id="userForm" style="margin-top:20px;"><div class="field"><label>Username</label><input id="newUsername" required></div><div class="field"><label>Password</label><div class="password-row"><input id="newUserPassword" type="password" minlength="6" required><button type="button" class="btn btn-ghost btn-sm password-toggle" data-target-id="newUserPassword">Show</button></div></div><div class="field"><label>Role</label><select id="newUserRole"><option value="staff">staff</option><option value="official">official</option><option value="manager">manager</option><option value="admin">admin</option></select></div><button class="btn btn-primary" type="submit">Add admin user</button></form></div>`;
  bindPasswordVisibility();
  document.querySelectorAll('[data-edit-password-user]').forEach(button => {
    button.onclick = async () => {
      const username = button.dataset.editPasswordUser;
      const newPassword = prompt(`Set a new password for ${username}:`, '');
      if (newPassword === null) return;
      const trimmed = newPassword.trim();
      if (!trimmed || trimmed.length < 6) {
        toast('Password must be at least 6 characters.', true);
        return;
      }
      await apiPost(`/api/admin/users/${encodeURIComponent(username)}/password`, { newPassword: trimmed });
      toast(`Password updated for ${username}.`);
      renderUsers();
    };
  });
  document.querySelectorAll('[data-delete-user]').forEach(button => {
    button.onclick = async () => {
      const username = button.dataset.deleteUser;
      if (!confirm(`Terminate admin user ${username}?`)) return;
      await apiDelete(`/api/admin/users/${encodeURIComponent(username)}`);
      toast('Admin user terminated.');
      renderUsers();
    };
  });
  document.getElementById('userForm').onsubmit = async event => {
    event.preventDefault();
    await apiPost('/api/admin/users', { username: newUsername.value, password: newUserPassword.value, role: newUserRole.value });
    toast('Admin user added.');
    renderUsers();
  };
}

function renderMsg(m) {
  return `
    <div class="msg ${m.author}" data-id="${m.id}">
      <div class="msg-avatar">${m.author === 'admin' ? 'AD' : initials('U')}</div>
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-author">${m.author === 'admin' ? 'Admin (you)' : 'Resident'}</span>
          <span class="msg-time">${timeAgo(m.createdAt)}${m.editedAt ? ' · edited' : ''}</span>
          ${m.author === 'admin' ? `<button class="btn btn-ghost btn-sm edit-msg" data-id="${m.id}" style="margin-left:auto; padding:2px 8px;">Edit</button>` : ''}
        </div>
        <div class="msg-text" data-text="${escapeHtml(m.text)}">${escapeHtml(m.text)}</div>
        ${m.attachment ? `<img class="msg-photo" src="${m.attachment}" alt="Attachment" onclick="this.style.maxWidth=this.style.maxWidth==='100%'?'800px':'100%'; this.style.cursor='pointer';">` : ''}
      </div>
    </div>`;
}

let verificationCollapsed = {};

async function renderNotificationPanel() {
  const panel = document.getElementById('notificationPanel');
  const bell = document.getElementById('notificationsBtn');
  if (!panel || !bell) return;
  const items = await apiGet('/api/admin/notifications').catch(() => []);
  const unread = items.filter(item => !item.read).length;
  const latestItem = items.find(item => !item.read) || items[0];
  if (typeof lastNotificationCount === 'number' && unread > lastNotificationCount) {
    const type = latestItem?.type === 'verification' ? 'verification' : 'concern';
    notifyNewActivity(latestItem?.message || 'New update received.', type);
  }
  lastNotificationCount = unread;
  lastNotificationId = latestItem?.id || null;
  bell.dataset.unread = unread;
  bell.classList.toggle('has-unread', unread > 0);
  panel.innerHTML = items.length ? items.slice(0, 8).map(item => `
    <div class="notification-item ${item.read ? 'read' : 'unread'}" data-id="${escapeHtml(item.id || '')}" data-thread-token="${escapeHtml(item.threadToken || '')}" data-notification-type="${escapeHtml(item.type || 'concern')}" style="cursor:pointer;">
      <div class="notification-dot ${item.read ? 'read' : ''}" aria-hidden="true"></div>
      <div style="flex:1; min-width:0;">
        <strong>${escapeHtml(item.message || 'Update')}</strong>
        <div class="thread-meta">${timeAgo(item.createdAt)}${item.read ? ' · read' : ' · unread'}</div>
      </div>
      <button class="btn btn-ghost btn-sm notification-delete-btn" type="button" data-notification-id="${escapeHtml(item.id || '')}" aria-label="Delete this alert">Delete</button>
    </div>
  `).join('') : '<div class="notification-empty">No recent updates.</div>';
  panel.querySelectorAll('.notification-item').forEach(itemEl => {
    const trigger = itemEl;
    trigger.onclick = async (event) => {
      if (event.target.closest('.notification-delete-btn')) return;
      const token = trigger.dataset.threadToken;
      const id = trigger.dataset.id;
      if (!token) return;
      const isVerification = trigger.dataset.notificationType === 'verification';
      if (isVerification) {
        try { await apiGet(`/api/admin/threads/${token}/verification`); } catch (_) {}
      }
      if (id) {
        await apiPost(`/api/admin/notifications/${encodeURIComponent(id)}/read`).catch(() => {});
      }
      await apiPost(`/api/admin/threads/${token}/read`).catch(() => {});
      panel.classList.remove('open');
      renderThreadDetail(token);
      renderNotificationPanel();
    };
  });
  panel.querySelectorAll('.notification-delete-btn').forEach(button => {
    button.onclick = async (event) => {
      event.stopPropagation();
      const id = button.dataset.notificationId;
      if (!id) return;
      await apiDelete(`/api/admin/notifications/${encodeURIComponent(id)}`);
      renderNotificationPanel();
    };
  });
}

async function renderThreadDetail(token) {
  const { thread, tower } = await apiGet(`/api/admin/threads/${token}`);
  const verification = currentRole === 'admin' ? await apiGet(`/api/admin/threads/${token}/verification`) : { status: 'admin-only' };
  const defaultCollapsed = verification.status !== 'not-submitted';
  verificationCollapsed[token] = verificationCollapsed[token] ?? defaultCollapsed;
  setTowerTheme(tower.accent);
  renderSidebar(); // refresh unread badges since viewing clears them

  const main = document.getElementById('main');
  main.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="backBtn" style="margin-bottom:14px;">← Back to list</button>
    <div class="eyebrow">${tower.name} · ${tower.codename}</div>
    <h2 style="font-size:1.4rem;">${escapeHtml(thread.title)}</h2>
    <div class="thread-status-bar">
      <span class="badge ${thread.status==='resolved'?'badge-satisfied':'badge-open'}"><span class="badge-dot"></span>${statusLabels[thread.status] || 'New'}</span>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <button class="btn btn-sm ${thread.adminUnread ? 'btn-ghost' : 'btn-primary'}" id="toggleReadStateBtn">${thread.adminUnread ? 'Mark as read' : 'Mark as unread'}</button>
        ${thread.deleted ? `<button class="btn btn-sm btn-primary" id="recoverBtn">Recover thread</button>` : (thread.status !== 'resolved' ? `<button class="btn btn-sm" id="closeBtn">Mark satisfied &amp; close</button>` : `<button class="btn btn-sm" id="reopenBtn">Reopen thread</button>`)}
        <button class="btn btn-sm btn-danger" id="deleteBtn">${thread.deleted ? 'Delete permanently' : 'Delete thread'}</button>
      </div>
    </div>
    <div class="card thread-controls">
      <div class="field"><label for="statusSelect">Workflow status</label><select id="statusSelect">${['new', 'in-progress', 'resolved'].map(status => `<option value="${status}" ${thread.status === status ? 'selected' : ''}>${statusLabels[status]}</option>`).join('')}</select></div>
      <div class="field"><label for="assignedTo">Assigned staff username</label><input id="assignedTo" value="${escapeHtml(thread.assignedTo || '')}" placeholder="Unassigned"></div>
      <div class="inline-save-row">
        <button class="btn btn-sm" id="saveControls">Save workflow</button>
        <span id="saveStatusPill" class="save-status">Saved</span>
      </div>
    </div>
    <div class="card"><strong>Concern details</strong><div class="thread-meta" style="margin-top:8px;">${escapeHtml(thread.category)} · ${escapeHtml(thread.urgency)} · ${escapeHtml(thread.location || 'Location not set')}</div></div>
    ${currentRole === 'admin' ? `<div class="card verification-review">
      <div class="collapsible-header" id="verificationToggle" style="${verification.status === 'not-submitted' ? 'cursor:default;' : ''}"><div><strong>Identity verification</strong></div>${verification.status === 'not-submitted' ? '' : `<button class="collapse-btn" type="button">${verification._collapsed ? '▶' : '▼'}</button>`}</div>
      <div class="collapsible-content ${verification._collapsed ? 'collapsed' : ''}">
        <div class="thread-meta" style="margin-top:8px;">${verification.status === 'not-submitted' ? 'Not submitted' : `${escapeHtml(verification.fullName)} · ${escapeHtml(verification.documentType)} · ID ${escapeHtml(verification.idNumber)} · <span style="font-weight:bold; color:${verification.status === 'verified' ? '#2FB8A6' : verification.status === 'rejected' ? '#D64545' : '#E8A33D'}">${verification.status === 'verified' ? '✓ Verified' : verification.status === 'rejected' ? '✗ Rejected' : escapeHtml(verification.status)}</span>`}</div>
        ${verification.viewUrl ? `${verification.mimeType === 'application/pdf' ? `<iframe class="verification-document" src="${verification.viewUrl}" title="Private verification document"></iframe>` : `<img class="verification-document" src="${verification.viewUrl}" alt="Private verification document">`}${['verified', 'rejected'].includes(verification.status) ? '' : `<div class="verification-actions"><button class="btn btn-sm btn-primary" id="verifyVerification">Verify ID</button><button class="btn btn-sm btn-danger" id="rejectVerification">Reject ID</button></div>`}` : ''}
      </div>
    </div>` : '<div class="card"><strong>Identity verification</strong><div class="thread-meta">Restricted to the administrator.</div></div>'}
    <div class="link-box" style="margin-bottom:18px;">
      <span style="flex:1; overflow:hidden; text-overflow:ellipsis;">${location.origin}/thread.html?token=${thread.token}</span>
      <button class="btn btn-sm btn-ghost" id="copyLinkBtn">Copy link</button>
    </div>

    <div class="card" id="messages">${thread.messages.map(renderMsg).join('')}</div>

    ${thread.status !== 'resolved' ? `
    <form class="card" id="replyForm" style="margin-top:16px;">
      <div class="field"><label>Reply as admin</label><textarea id="replyText" placeholder="Respond to this concern..."></textarea></div>
      <div class="field"><label>Attach a photo (optional)</label>
        <div class="upload-drop" id="dropZone">Tap to add a photo</div>
        <input type="file" id="fileInput" accept="image/*" style="display:none;">
      </div>
      <button class="btn btn-primary" type="submit">Send reply</button>
    </form>` : `<div class="card" style="margin-top:16px; text-align:center; color:var(--text-dim);">This thread is closed. Reopen it to reply again.</div>`}
    <div class="card" style="margin-top:16px;"><strong>Resolution history</strong><div class="thread-meta" style="margin-top:10px;">${(thread.history || []).map(item => `<div>${escapeHtml(item.action)} · ${timeAgo(item.at)} · ${escapeHtml(item.by || 'System')}</div>`).join('')}</div></div>
    <form class="card" id="maintenanceForm" style="margin-top:16px;"><strong>Schedule maintenance</strong><div class="field"><label for="maintenanceDate">Date and time</label><input id="maintenanceDate" type="datetime-local" required></div><div class="field"><label for="maintenanceVendor">Vendor or staff</label><input id="maintenanceVendor" required></div><div class="field"><label for="maintenanceNotes">Notes</label><textarea id="maintenanceNotes"></textarea></div><button class="btn btn-sm" type="submit">Schedule</button></form>
  `;

  document.getElementById('backBtn').onclick = renderThreadList;
  const toggleReadStateBtn = document.getElementById('toggleReadStateBtn');
  if (toggleReadStateBtn) {
    toggleReadStateBtn.onclick = async () => {
      const unread = !thread.adminUnread;
      await apiPost(`/api/admin/threads/${token}/${unread ? 'unread' : 'read'}`);
      setSaveState(unread ? 'Marked unread' : 'Marked read');
      renderSidebar();
      renderThreadList();
      renderNotificationPanel();
    };
  }
  document.getElementById('saveControls').onclick = async () => {
    try {
      await apiPatch(`/api/admin/threads/${token}/status`, { status: document.getElementById('statusSelect').value });
      await apiPatch(`/api/admin/threads/${token}/assignment`, { assignedTo: document.getElementById('assignedTo').value });
      setSaveState('Saved automatically');
      toast('Workflow updated.');
      renderThreadDetail(token);
    } catch (err) {
      setSaveState(err.message, true);
      toast(err.message, true);
    }
  };
  document.getElementById('maintenanceForm').onsubmit = async event => {
    event.preventDefault();
    await apiPost('/api/admin/maintenance', { token, scheduledFor: document.getElementById('maintenanceDate').value, vendor: document.getElementById('maintenanceVendor').value, notes: document.getElementById('maintenanceNotes').value });
    toast('Maintenance scheduled.');
    event.target.reset();
  };
  const updateVerification = async status => {
    await apiPatch(`/api/admin/threads/${token}/verification`, { status });
    toast(`ID ${status}.`);
    renderThreadDetail(token);
  };
  const verifyVerification = document.getElementById('verifyVerification');
  const rejectVerification = document.getElementById('rejectVerification');
  if (verifyVerification) verifyVerification.onclick = () => updateVerification('verified');
  if (rejectVerification) rejectVerification.onclick = () => updateVerification('rejected');
  
  const verificationToggle = document.getElementById('verificationToggle');
  if (verificationToggle && verification.status !== 'not-submitted') {
    const content = document.querySelector('.verification-review .collapsible-content');
    const btn = document.querySelector('.collapse-btn');
    if (content) content.classList.toggle('collapsed', !!verificationCollapsed[token]);
    if (btn) btn.textContent = verificationCollapsed[token] ? '▶' : '▼';
    verificationToggle.addEventListener('click', (e) => {
      e.preventDefault();
      verificationCollapsed[token] = !verificationCollapsed[token];
      if (content) content.classList.toggle('collapsed', !!verificationCollapsed[token]);
      if (btn) btn.textContent = verificationCollapsed[token] ? '▶' : '▼';
    });
  }
  
  document.getElementById('copyLinkBtn').onclick = () => {
    navigator.clipboard.writeText(`${location.origin}/thread.html?token=${thread.token}`);
    toast('Link copied.');
  };

  const closeBtn = document.getElementById('closeBtn');
  if (closeBtn) closeBtn.onclick = async () => {
    if (!confirm('Mark this thread as satisfied and close it?')) return;
    await apiPost(`/api/admin/threads/${token}/close`);
    currentFilter.status = 'resolved';
    currentFilter.towerId = null;
    renderSidebar();
    renderThreadList();
    toast('Thread moved to resolved.');
  };
  const reopenBtn = document.getElementById('reopenBtn');
  if (reopenBtn) reopenBtn.onclick = async () => {
    await apiPost(`/api/admin/threads/${token}/reopen`);
    currentFilter.status = null;
    currentFilter.towerId = null;
    renderSidebar();
    renderThreadList();
    toast('Thread reopened.');
  };
  const recoverBtn = document.getElementById('recoverBtn');
  if (recoverBtn) recoverBtn.onclick = async () => {
    await apiPost(`/api/admin/threads/${token}/recover`);
    toast('Thread recovered.');
    renderThreadDetail(token);
  };
  document.getElementById('deleteBtn').onclick = async () => {
    if (thread.deleted) {
      if (!confirm('Permanently delete this thread? This cannot be undone.')) return;
      await apiDelete(`/api/admin/threads/${token}`);
      toast('Thread deleted permanently.');
      renderThreadList();
      renderSidebar();
      return;
    }
    if (!confirm('Soft delete this thread so it can be recovered later?')) return;
    await apiDelete(`/api/admin/threads/${token}`);
    toast('Thread moved to deleted state.');
    renderThreadList();
    renderSidebar();
  };

  main.querySelectorAll('.edit-msg').forEach(btn => {
    btn.onclick = async () => {
      const msgEl = btn.closest('.msg').querySelector('.msg-text');
      const current = msgEl.dataset.text;
      const next = prompt('Edit message:', current);
      if (next === null || !next.trim() || next === current) return;
      await apiPatch(`/api/admin/threads/${token}/messages/${btn.dataset.id}`, { text: next.trim() });
      toast('Message updated.');
      renderThreadDetail(token);
    };
  });

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  if (dropZone) {
    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = () => { if (fileInput.files[0]) { dropZone.classList.add('has-file'); dropZone.textContent = `Selected: ${fileInput.files[0].name}`; } };
  }
  const replyForm = document.getElementById('replyForm');
  if (replyForm) replyForm.onsubmit = async (e) => {
    e.preventDefault();
    const text = document.getElementById('replyText').value.trim();
    if (!text) { toast('Write a reply first.', true); return; }
    const fd = new FormData();
    fd.append('message', text);
    if (fileInput.files[0]) fd.append('attachment', fileInput.files[0]);
    try {
      await apiPost(`/api/admin/threads/${token}/reply`, fd, true);
      toast('Reply sent.');
      renderThreadDetail(token);
    } catch (err) { toast(err.message, true); }
  };
}

async function logoutAdmin() {
  try {
    await apiPost('/api/admin/logout');
  } catch (error) {
    // Ignore logout errors and force the session to end locally.
  }
  clearAdminSession();
  location.href = '/admin-login.html?force=1';
}

document.getElementById('logoutBtn')?.addEventListener('click', logoutAdmin);

document.getElementById('userViewBtn')?.addEventListener('click', async () => {
  const token = getStoredAdminToken();
  const role = currentRole || 'admin';
  const session = await apiGet('/api/admin/session').catch(() => null);
  if (token && session && session.isAdmin) {
    sessionStorage.setItem('adminViewMode', JSON.stringify({
      token,
      role: session.role || role,
      username: session.username || 'Admin'
    }));
    localStorage.setItem('adminToken', token);
    localStorage.setItem('fopm-admin-token', token);
  }
  window.location.href = '/index.html';
});
document.getElementById('createBtn').onclick = renderCreateForm;

function closeHeaderPopovers(except = null) {
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsDropdown = document.getElementById('settingsDropdown');
  const notificationsBtn = document.getElementById('notificationsBtn');
  const notificationPanel = document.getElementById('notificationPanel');

  if (settingsDropdown && except !== 'settings') {
    settingsDropdown.setAttribute('hidden', 'hidden');
    settingsBtn?.setAttribute('aria-expanded', 'false');
  }
  if (notificationPanel && except !== 'notifications') {
    notificationPanel.classList.remove('open');
    notificationsBtn?.setAttribute('aria-expanded', 'false');
  }
}

document.getElementById('settingsBtn').onclick = () => {
  const dropdown = document.getElementById('settingsDropdown');
  if (!dropdown) return;
  const shouldOpen = dropdown.hasAttribute('hidden');
  closeHeaderPopovers('settings');
  if (shouldOpen) {
    dropdown.removeAttribute('hidden');
    document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'true');
  } else {
    dropdown.setAttribute('hidden', 'hidden');
    document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
  }
};

document.getElementById('notificationsBtn').onclick = async () => {
  const panel = document.getElementById('notificationPanel');
  const btn = document.getElementById('notificationsBtn');
  if (!panel || !btn) return;
  const shouldOpen = !panel.classList.contains('open');
  closeHeaderPopovers('notifications');
  if (shouldOpen) {
    panel.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    await renderNotificationPanel();
  } else {
    panel.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
};

document.addEventListener('click', (event) => {
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsDropdown = document.getElementById('settingsDropdown');
  const notificationBtn = document.getElementById('notificationsBtn');
  const notificationPanel = document.getElementById('notificationPanel');
  if (!settingsBtn || !settingsDropdown || !notificationBtn || !notificationPanel) return;
  const clickedSettings = event.target.closest('#settingsBtn') || event.target.closest('#settingsDropdown');
  const clickedNotifications = event.target.closest('#notificationsBtn') || event.target.closest('#notificationPanel');
  if (!clickedSettings) {
    settingsDropdown.setAttribute('hidden', 'hidden');
    settingsBtn.setAttribute('aria-expanded', 'false');
  }
  if (!clickedNotifications) {
    notificationPanel.classList.remove('open');
    notificationBtn.setAttribute('aria-expanded', 'false');
  }
});

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', async () => {
    const action = button.dataset.action;
    const dropdown = document.getElementById('settingsDropdown');
    if (dropdown) dropdown.setAttribute('hidden', 'hidden');
    if (action === 'analytics') return renderAnalytics().catch(error => toast(error.message, true));
    if (action === 'audit') return renderAuditLog().catch(error => toast(error.message, true));
    if (action === 'export') return window.location.href = '/api/admin/export.csv';
    if (action === 'users') return renderUsers().catch(error => toast(error.message, true));
    if (action === 'logout') return logoutAdmin();
  });
});

function startAdminPolling() {
  if (adminPollHandle) return;
  adminPollHandle = setInterval(() => {
    if (document.hidden || document.visibilityState !== 'visible') return;
    renderSidebar().catch(() => {});
    renderNotificationPanel().catch(() => {});
  }, 30000);
}

(async function init() {
  try {
    await guard();
    await renderSidebar();
    await renderThreadList();
    await renderNotificationPanel();
    const notificationsBtn = document.getElementById('notificationsBtn');
    const notificationPanel = document.getElementById('notificationPanel');
    if (notificationsBtn) {
      notificationsBtn.setAttribute('aria-expanded', 'false');
      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'btn btn-ghost btn-sm';
      clearButton.textContent = 'Clear all';
      clearButton.style.marginTop = '10px';
      clearButton.style.width = '100%';
      clearButton.onclick = async () => {
        await apiPost('/api/admin/notifications/clear');
        lastNotificationCount = 0;
        renderNotificationPanel();
      };
      if (!notificationPanel.querySelector('.notification-clear')) {
        clearButton.classList.add('notification-clear');
        notificationPanel.appendChild(clearButton);
      }
    }
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#notificationsBtn') && !event.target.closest('#notificationPanel')) {
        notificationPanel?.classList.remove('open');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        renderSidebar().catch(() => {});
        renderNotificationPanel().catch(() => {});
      }
    });
    startAdminPolling();
  } catch (error) {
    if (error?.message !== 'redirect') {
      console.error(error);
    }
  }
})();

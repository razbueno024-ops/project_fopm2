const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { customAlphabet } = require('nanoid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production.');
}

// Short, link-friendly, unambiguous token for public thread URLs
// (no 0/O/1/I confusion) — this is what "Freedom Wall" links are built from.
const genToken = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 10);
const ID_NUMBER_PATTERN = /^[A-Z0-9-]{6,40}$/i;

// ---------- middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fopm-local-development-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 } // 8 hours
}));
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const VERIFICATION_DIR = path.join(__dirname, 'private-verifications');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(VERIFICATION_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${uuidv4()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('ATTACHMENT_MUST_BE_IMAGE'), ok);
  }
});

const verificationUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, VERIFICATION_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`)
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf$/i.test(file.mimetype);
    cb(ok ? null : new Error('VERIFICATION_MUST_BE_IMAGE_OR_PDF'), ok);
  }
});

function hasValidFileSignature(filePath, mimeType) {
  const bytes = fs.readFileSync(filePath);
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString());
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Admin login required.' });
}

function requireAdminRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.isAdmin) return res.status(401).json({ error: 'Admin login required.' });
    if (roles.length && !roles.includes(req.session.role || 'admin')) {
      return res.status(403).json({ error: 'Your admin role cannot perform this action.' });
    }
    next();
  };
}

const canModerate = requireAdminRole('admin', 'manager');
const canManageUsers = requireAdminRole('admin');
const canReviewIdentity = requireAdminRole('admin');

function ensureState(state) {
  state.adminUsers ||= [{ username: state.admin.username, role: 'admin', passwordHash: state.admin.passwordHash }];
  state.notifications ||= [];
  state.maintenance ||= [];
  state.threads.forEach(thread => {
    thread.status = thread.status === 'satisfied' ? 'resolved' : (thread.status || 'new');
    thread.category ||= 'General';
    thread.urgency ||= 'normal';
    thread.location ||= '';
    thread.assignedTo ||= null;
    thread.history ||= [{ action: 'created', at: thread.createdAt, by: thread.submitterName || 'System' }];
  });
  return state;
}

function publicThread(t) {
  const { verification, pendingFeedback, ...safeThread } = t;
  return {
    ...safeThread,
    messages: safeThread.messages.map(message => ({
      ...message,
      attachment: message.attachment && fs.existsSync(path.join(__dirname, message.attachment.replace(/^\//, ''))) ? message.attachment : null
    })),
    verification: verification ? { status: verification.status } : { status: 'not-submitted' }
  };
}

function validateImageUpload(file) {
  return file && hasValidFileSignature(file.path, file.mimetype);
}

function storedAttachment(attachment) {
  return attachment && fs.existsSync(path.join(__dirname, attachment.replace(/^\//, ''))) ? attachment : null;
}

function removeUploadedFiles(files) {
  Object.values(files || {}).flat().forEach(file => fs.unlink(file.path, () => {}));
}

// ================= AUTH =================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const state = ensureState(db.load());
  const account = state.adminUsers.find(user => user.username === username);
  if (!account || !password || !bcrypt.compareSync(password, account.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  req.session.isAdmin = true;
  req.session.username = username;
  req.session.role = account.role || 'admin';
  res.json({ ok: true, username, role: req.session.role });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin), username: req.session?.username || null, role: req.session?.role || null });
});

app.post('/api/admin/users', requireAdminRole('admin'), (req, res) => {
  const { username, password, role = 'staff' } = req.body || {};
  if (!username || !password || password.length < 6 || !['admin', 'manager', 'staff'].includes(role)) {
    return res.status(400).json({ error: 'Provide a username, a password of at least 6 characters, and a valid role.' });
  }
  db.update(state => {
    ensureState(state);
    if (state.adminUsers.some(user => user.username === username)) return { error: 'exists' };
    state.adminUsers.push({ username, role, passwordHash: bcrypt.hashSync(password, 10) });
    return { ok: true };
  }).then(result => result?.error ? res.status(409).json({ error: 'That admin username already exists.' }) : res.status(201).json({ ok: true }));
});

app.get('/api/admin/users', canManageUsers, (req, res) => {
  const state = ensureState(db.load());
  res.json(state.adminUsers.map(({ username, role }) => ({ username, role })));
});

app.post('/api/admin/change-password', canManageUsers, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const state = db.load();
  if (!bcrypt.compareSync(currentPassword || '', state.admin.passwordHash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  db.update(d => { d.admin.passwordHash = bcrypt.hashSync(newPassword, 10); });
  res.json({ ok: true });
});

// ================= TOWERS (public) =================
app.get('/api/towers', (req, res) => {
  const state = db.load();
  const towers = state.towers.map(t => {
    const threads = state.threads.filter(th => th.towerId === t.id);
    return {
      ...t,
      totalThreads: threads.length,
      openThreads: threads.filter(th => th.status !== 'resolved' && th.status !== 'satisfied').length
    };
  });
  res.json(towers);
});

// Admin-only view with unread counts, used for the notification badges.
app.get('/api/admin/towers', requireAdmin, (req, res) => {
  const state = db.load();
  const towers = state.towers.map(t => {
    const threads = state.threads.filter(th => th.towerId === t.id);
    return {
      ...t,
      totalThreads: threads.length,
      openThreads: threads.filter(th => th.status !== 'resolved' && th.status !== 'satisfied').length,
      unread: threads.filter(th => th.adminUnread).length
    };
  });
  res.json(towers);
});

// Public feed of concerns for one tower (titles/snippets only — the full
// conversation lives behind each concern's own link).
app.get('/api/towers/:id/threads', (req, res) => {
  const towerId = Number(req.params.id);
  const state = ensureState(db.load());
  if (!state.towers.some(t => t.id === towerId)) return res.status(404).json({ error: 'Tower not found.' });
  const threads = state.threads
    .filter(t => t.towerId === towerId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(t => ({
      token: t.token,
      towerId: t.towerId,
      title: t.title,
      status: t.status,
      category: t.category,
      urgency: t.urgency,
      location: t.location,
      submitterName: t.submitterName || 'Anonymous',
      submitterUnit: t.submitterUnit || '',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messageCount: t.messages.length,
      thumbnail: storedAttachment((t.messages.find(m => storedAttachment(m.attachment)) || {}).attachment),
      preview: (t.messages[0]?.text || '').slice(0, 140)
    }));
  res.json(threads);
});

app.post('/api/admin/towers/:id/threads', canModerate, upload.single('attachment'), (req, res) => {
  const towerId = Number(req.params.id);
  const state = ensureState(db.load());
  const tower = state.towers.find(t => t.id === towerId);
  if (!tower) return res.status(404).json({ error: 'Tower not found.' });

  const { title, message, submitterName, submitterUnit, category = 'General', urgency = 'normal', location = '' } = req.body || {};
  if (req.file && !validateImageUpload(req.file)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'The concern image does not match its declared format.' });
  }
  if (!title || !title.trim() || !message || !message.trim()) {
    return res.status(400).json({ error: 'Please provide both a title and a description of the concern.' });
  }

  const words = title.toLowerCase().split(/\W+/).filter(word => word.length > 2);
  const duplicate = state.threads.find(thread => thread.towerId === towerId && thread.status !== 'resolved' &&
    words.filter(word => thread.title.toLowerCase().includes(word)).length >= Math.max(1, Math.ceil(words.length / 2)));
  if (duplicate) return res.status(409).json({ error: `Possible duplicate concern: "${duplicate.title}". Review it before creating another.` });

  const now = new Date().toISOString();
  const thread = {
    id: null,
    token: genToken(),
    towerId,
    title: title.trim().slice(0, 140),
    submitterName: (submitterName || 'Admin').trim().slice(0, 80),
    submitterUnit: (submitterUnit || '').trim().slice(0, 40),
    status: 'new',
    category: category.trim().slice(0, 40),
    urgency: ['low', 'normal', 'high', 'emergency'].includes(urgency) ? urgency : 'normal',
    location: location.trim().slice(0, 120),
    assignedTo: null,
    adminUnread: false,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    history: [{ action: 'created', at: now, by: req.session.username }],
    messages: [{
      id: uuidv4(),
      author: 'admin',
      text: message.trim(),
      attachment: req.file ? `/uploads/${req.file.filename}` : null,
      createdAt: now
    }]
  };

  db.update(d => {
    thread.id = d.nextThreadSeq++;
    d.threads.push(thread);
  }).then(() => {
    res.status(201).json({ token: thread.token, link: `/thread.html?token=${thread.token}` });
  });
});

app.post('/api/towers/:id/threads', requireAdmin, (req, res) => {
  res.status(403).json({ error: 'Only the admin can create a new concern. Residents can reply with feedback from a concern link.' });
});

// ================= THREADS (public via token link) =================
app.get('/api/threads/:token', (req, res) => {
  const state = ensureState(db.load());
  const thread = state.threads.find(t => t.token === req.params.token);
  if (!thread) return res.status(404).json({ error: 'This concern link is invalid or was removed.' });
  const tower = state.towers.find(t => t.id === thread.towerId);
  res.json({ thread: publicThread(thread), tower });
});

// A resident can follow up on their own concern from the same link.
// (No login — the unlisted token link is the access control, in the
// spirit of a freedom wall.)
app.post('/api/threads/:token/reply', (req, res) => {
  return res.status(410).json({ error: 'Resident concerns must be submitted through the private verification form.' });
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (!req.file) return res.status(400).json({ error: 'A photo is required for every follow-up.' });

  db.update(d => {
    ensureState(d);
    const thread = d.threads.find(t => t.token === req.params.token);
    if (!thread) return { error: 'not_found' };
    if (thread.status === 'resolved') return { error: 'closed' };
    if (thread.verification?.status !== 'verified') return { error: 'verification_required' };
    const now = new Date().toISOString();
    thread.messages.push({
      id: uuidv4(),
      author: 'user',
      text: message.trim(),
      attachment: req.file ? `/uploads/${req.file.filename}` : null,
      createdAt: now
    });
    thread.updatedAt = now;
    thread.adminUnread = true;
    thread.history ||= [];
    thread.history.push({ action: 'feedback', at: now, by: 'Anonymous resident' });
    state.notifications.push({ id: uuidv4(), type: 'feedback', threadToken: thread.token, towerId: thread.towerId, message: 'New anonymous resident feedback', createdAt: now, read: false });
    return { ok: true };
  }).then(result => {
    if (result?.error === 'not_found') return res.status(404).json({ error: 'This concern link is invalid or was removed.' });
    if (result?.error === 'closed') return res.status(400).json({ error: 'This thread is closed. Submit a new concern if the issue continues.' });
    if (result?.error === 'verification_required') return res.status(403).json({ error: 'Admin verification is required before sending feedback.' });
    res.json({ ok: true });
  });
});

app.post('/api/threads/:token/verification', verificationUpload.fields([{ name: 'idDocument', maxCount: 1 }, { name: 'concernPhoto', maxCount: 1 }]), (req, res) => {
  const { fullName, documentType, idNumber } = req.body || {};
  const message = req.body?.message;
  const idFile = req.files?.idDocument?.[0];
  const concernPhoto = req.files?.concernPhoto?.[0];
  if (!idFile || !fullName?.trim() || !documentType?.trim() || !idNumber?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Provide your name, ID type, ID number, ID document, and concern message.' });
  }
  const currentState = ensureState(db.load());
  const currentThread = currentState.threads.find(item => item.token === req.params.token);
  if (!currentThread || currentThread.status === 'resolved' || currentThread.verification?.status === 'pending' || currentThread.verification?.status === 'verified') {
    removeUploadedFiles(req.files);
    if (!currentThread) return res.status(404).json({ error: 'Concern not found.' });
    if (currentThread.status === 'resolved') return res.status(409).json({ error: 'Resolved threads cannot receive verification.' });
    return res.status(409).json({ error: 'This concern already has an active or completed verification.' });
  }
  if (!ID_NUMBER_PATTERN.test(idNumber.trim())) {
    if (concernPhoto) fs.unlink(concernPhoto.path, () => {});
    return res.status(400).json({ error: 'ID number must contain only letters, numbers, or hyphens and be 6–40 characters long.' });
  }
  if (!validateImageUpload(idFile) && idFile.mimetype !== 'application/pdf' || !hasValidFileSignature(idFile.path, idFile.mimetype) || (concernPhoto && (!/^image\//i.test(concernPhoto.mimetype) || !validateImageUpload(concernPhoto)))) {
    fs.unlink(idFile.path, () => {});
    if (concernPhoto) fs.unlink(concernPhoto.path, () => {});
    return res.status(400).json({ error: 'The uploaded ID file does not match its declared format.' });
  }
  db.update(state => {
    ensureState(state);
    const thread = state.threads.find(item => item.token === req.params.token);
    if (!thread) return { error: 'not_found' };
    if (thread.verification?.fileName) {
      fs.unlink(path.join(VERIFICATION_DIR, path.basename(thread.verification.fileName)), () => {});
    }
    if (thread.pendingFeedback?.attachment) fs.unlink(path.join(__dirname, thread.pendingFeedback.attachment.replace(/^\//, '')), () => {});
    thread.verification = {
      status: 'pending',
      fullName: fullName.trim().slice(0, 120),
      documentType: documentType.trim().slice(0, 60),
      idNumber: idNumber.trim().slice(0, 40),
      mimeType: idFile.mimetype,
      fileName: idFile.filename,
      submittedAt: new Date().toISOString()
    };
    thread.pendingFeedback = { text: message.trim(), attachment: concernPhoto ? `/uploads/${concernPhoto.filename}` : null, submittedAt: thread.verification.submittedAt };
    thread.adminUnread = true;
    state.notifications.push({ id: uuidv4(), type: 'verification', threadToken: thread.token, towerId: thread.towerId, message: 'New identity verification requires review', createdAt: thread.verification.submittedAt, read: false });
    thread.history.push({ action: 'verification:submitted', at: thread.verification.submittedAt, by: 'Anonymous resident' });
    return { ok: true };
  }).then(result => {
    if (result?.error) return res.status(404).json({ error: 'Concern not found.' });
    res.status(201).json({ ok: true, status: 'pending' });
  });
});

// ================= ADMIN THREAD MANAGEMENT =================
app.get('/api/admin/threads', requireAdmin, (req, res) => {
  const state = ensureState(db.load());
  const towerId = req.query.towerId ? Number(req.query.towerId) : null;
  const status = req.query.status || null;
  let threads = state.threads;
  if (towerId) threads = threads.filter(t => t.towerId === towerId);
  if (status) threads = threads.filter(t => t.status === status);
  threads = threads.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(threads);
});

app.patch('/api/admin/threads/:token/status', canModerate, (req, res) => {
  const allowed = ['new', 'in-progress', 'resolved'];
  const { status } = req.body || {};
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid workflow status.' });
  db.update(state => {
    ensureState(state);
    const thread = state.threads.find(item => item.token === req.params.token);
    if (!thread) return { error: 'not_found' };
    const now = new Date().toISOString();
    thread.status = status;
    thread.closedAt = status === 'resolved' ? now : null;
    thread.updatedAt = now;
    thread.history.push({ action: `status:${status}`, at: now, by: req.session.username });
    return { ok: true };
  }).then(result => result?.error ? res.status(404).json({ error: 'Not found.' }) : res.json({ ok: true }));
});

app.patch('/api/admin/threads/:token/assignment', canModerate, (req, res) => {
  db.update(state => {
    ensureState(state);
    const thread = state.threads.find(item => item.token === req.params.token);
    if (!thread) return { error: 'not_found' };
    thread.assignedTo = (req.body?.assignedTo || '').trim() || null;
    thread.history.push({ action: `assigned:${thread.assignedTo || 'unassigned'}`, at: new Date().toISOString(), by: req.session.username });
    return { ok: true };
  }).then(result => result?.error ? res.status(404).json({ error: 'Not found.' }) : res.json({ ok: true }));
});

app.get('/api/admin/analytics', canModerate, (req, res) => {
  const state = ensureState(db.load());
  const byStatus = {}, byCategory = {}, byTower = {};
  state.threads.forEach(thread => {
    byStatus[thread.status] = (byStatus[thread.status] || 0) + 1;
    byCategory[thread.category] = (byCategory[thread.category] || 0) + 1;
    byTower[thread.towerId] = (byTower[thread.towerId] || 0) + 1;
  });
  res.json({ total: state.threads.length, byStatus, byCategory, byTower, averageResolutionHours: resolutionHours(state.threads) });
});

function resolutionHours(threads) {
  const resolved = threads.filter(thread => thread.status === 'resolved' && thread.closedAt);
  if (!resolved.length) return 0;
  return Math.round(resolved.reduce((sum, thread) => sum + (new Date(thread.closedAt) - new Date(thread.createdAt)) / 3600000, 0) / resolved.length * 10) / 10;
}

app.get('/api/admin/export.csv', canManageUsers, (req, res) => {
  const state = ensureState(db.load());
  const rows = [['id', 'tower', 'title', 'status', 'category', 'urgency', 'location', 'assignedTo', 'createdAt', 'updatedAt']];
  state.threads.forEach(thread => rows.push([thread.id, thread.towerId, thread.title, thread.status, thread.category, thread.urgency, thread.location, thread.assignedTo || '', thread.createdAt, thread.updatedAt]));
  const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="fopm-concerns.csv"');
  res.send(csv);
});

app.get('/api/admin/notifications', canModerate, (req, res) => {
  const state = ensureState(db.load());
  res.json(state.notifications.slice().reverse().slice(0, 50));
});

app.post('/api/admin/maintenance', canModerate, (req, res) => {
  const { token, scheduledFor, vendor, notes = '' } = req.body || {};
  if (!token || !scheduledFor || !vendor) return res.status(400).json({ error: 'Token, schedule date, and vendor are required.' });
  db.update(state => {
    ensureState(state);
    if (!state.threads.some(thread => thread.token === token)) return { error: 'not_found' };
    state.maintenance.push({ id: uuidv4(), token, scheduledFor, vendor, notes, status: 'scheduled', createdAt: new Date().toISOString() });
    return { ok: true };
  }).then(result => result?.error ? res.status(404).json({ error: 'Concern not found.' }) : res.status(201).json({ ok: true }));
});

app.get('/api/admin/maintenance', canModerate, (req, res) => res.json(ensureState(db.load()).maintenance));

app.get('/api/admin/threads/:token', canModerate, (req, res) => {
  const state = ensureState(db.load());
  const thread = state.threads.find(t => t.token === req.params.token);
  if (!thread) return res.status(404).json({ error: 'Not found.' });
  // Viewing a thread as admin clears its notification.
  db.update(d => {
    const th = d.threads.find(t => t.token === req.params.token);
    if (th) th.adminUnread = false;
  });
  const tower = state.towers.find(t => t.id === thread.towerId);
  res.json({ thread, tower });
});

app.get('/api/admin/threads/:token/verification', canReviewIdentity, (req, res) => {
  const state = ensureState(db.load());
  const thread = state.threads.find(item => item.token === req.params.token);
  if (!thread) return res.status(404).json({ error: 'Not found.' });
  if (!thread.verification) return res.json({ status: 'not-submitted' });
  res.json({ ...thread.verification, mimeType: thread.verification.mimeType || null, viewUrl: `/api/admin/threads/${thread.token}/verification/document` });
});

app.get('/api/admin/threads/:token/verification/document', canReviewIdentity, (req, res) => {
  const state = ensureState(db.load());
  const thread = state.threads.find(item => item.token === req.params.token);
  if (!thread?.verification?.fileName) return res.status(404).json({ error: 'Verification document not found.' });
  const filePath = path.join(VERIFICATION_DIR, path.basename(thread.verification.fileName));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Verification document not found.' });
  res.type(thread.verification.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(filePath);
});

app.patch('/api/admin/threads/:token/verification', canReviewIdentity, (req, res) => {
  const allowed = ['pending', 'verified', 'rejected'];
  if (!allowed.includes(req.body?.status)) return res.status(400).json({ error: 'Invalid verification status.' });
  db.update(state => {
    ensureState(state);
    const thread = state.threads.find(item => item.token === req.params.token);
    if (!thread?.verification) return { error: 'not_found' };
    if (thread.status === 'resolved') return { error: 'closed' };
    if (req.body.status === 'verified' && thread.verification.status === 'verified') return { error: 'already_verified' };
    thread.verification.status = req.body.status;
    thread.verification.reviewedAt = new Date().toISOString();
    thread.verification.reviewedBy = req.session.username;
    thread.history.push({ action: `verification:${req.body.status}`, at: thread.verification.reviewedAt, by: req.session.username });
    if (req.body.status === 'verified' && thread.pendingFeedback) {
      thread.messages.push({ id: uuidv4(), author: 'user', text: thread.pendingFeedback.text, attachment: thread.pendingFeedback.attachment, createdAt: thread.pendingFeedback.submittedAt });
      thread.updatedAt = thread.verification.reviewedAt;
      thread.adminUnread = true;
      delete thread.pendingFeedback;
      thread.history.push({ action: 'concern:published', at: thread.updatedAt, by: req.session.username });
    }
    if (req.body.status === 'rejected') {
      if (thread.pendingFeedback?.attachment) fs.unlink(path.join(__dirname, thread.pendingFeedback.attachment.replace(/^\//, '')), () => {});
      delete thread.pendingFeedback;
    }
    return { ok: true };
  }).then(result => {
    if (result?.error === 'not_found') return res.status(404).json({ error: 'Verification not found.' });
    if (result?.error === 'closed') return res.status(409).json({ error: 'Resolved threads cannot receive verification.' });
    if (result?.error === 'already_verified') return res.status(409).json({ error: 'This ID has already been verified.' });
    res.json({ ok: true });
  });
});

app.post('/api/admin/threads/:token/reply', canModerate, upload.single('attachment'), (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (req.file && !validateImageUpload(req.file)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'The reply image does not match its declared format.' });
  }
  db.update(d => {
    ensureState(d);
    const thread = d.threads.find(t => t.token === req.params.token);
    if (!thread) return { error: 'not_found' };
    const now = new Date().toISOString();
    thread.messages.push({
      id: uuidv4(),
      author: 'admin',
      text: message.trim(),
      attachment: req.file ? `/uploads/${req.file.filename}` : null,
      createdAt: now
    });
    thread.updatedAt = now;
    thread.adminUnread = false;
    d.notifications.push({ id: uuidv4(), type: 'admin_reply', threadToken: thread.token, residentUsername: thread.residentUsername || null, towerId: thread.towerId, message: 'The admin replied to your concern', createdAt: now, read: false });
    return { ok: true };
  }).then(result => {
    if (result?.error) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });
});

// Close a thread — the admin marks the concern "Satisfied" once resolved.
app.post('/api/admin/threads/:token/close', canModerate, (req, res) => {
  db.update(d => {
    ensureState(d);
    const thread = d.threads.find(t => t.token === req.params.token);
    if (!thread) return { error: 'not_found' };
    thread.status = 'resolved';
    thread.closedAt = new Date().toISOString();
    thread.updatedAt = thread.closedAt;
    thread.adminUnread = false;
    thread.history.push({ action: 'status:resolved', at: thread.closedAt, by: req.session.username });
    return { ok: true };
  }).then(result => {
    if (result?.error) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });
});

// Reopen a thread if the admin needs to revisit it.
app.post('/api/admin/threads/:token/reopen', canModerate, (req, res) => {
  db.update(d => {
    ensureState(d);
    const thread = d.threads.find(t => t.token === req.params.token);
    if (!thread) return { error: 'not_found' };
    thread.status = 'in-progress';
    thread.closedAt = null;
    thread.updatedAt = new Date().toISOString();
    thread.history.push({ action: 'status:in-progress', at: thread.updatedAt, by: req.session.username });
    return { ok: true };
  }).then(result => {
    if (result?.error) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });
});

// Edit a message's text — admin only, per project requirement #6.
app.patch('/api/admin/threads/:token/messages/:messageId', canModerate, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text cannot be empty.' });
  db.update(d => {
    const thread = d.threads.find(t => t.token === req.params.token);
    if (!thread) return { error: 'not_found' };
    const msg = thread.messages.find(m => m.id === req.params.messageId);
    if (!msg) return { error: 'not_found' };
    msg.text = text.trim();
    msg.editedAt = new Date().toISOString();
    return { ok: true };
  }).then(result => {
    if (result?.error) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });
});

// Delete an entire thread — admin only.
app.delete('/api/admin/threads/:token', canManageUsers, (req, res) => {
  db.update(d => {
    const idx = d.threads.findIndex(t => t.token === req.params.token);
    if (idx === -1) return { error: 'not_found' };
    const [removed] = d.threads.splice(idx, 1);
    // best-effort cleanup of attached photos
    removed.messages.forEach(m => {
      if (m.attachment) {
        const p = path.join(__dirname, m.attachment.replace(/^\//, ''));
        fs.unlink(p, () => {});
      }
    });
    return { ok: true };
  }).then(result => {
    if (result?.error) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });
});

// ================= FALLBACKS =================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err && err.message === 'ATTACHMENT_MUST_BE_IMAGE') {
    return res.status(400).json({ error: 'Attachment must be an image file (jpg, png, webp, gif, heic).' });
  }
  if (err && err.message === 'VERIFICATION_MUST_BE_IMAGE_OR_PDF') {
    return res.status(400).json({ error: 'Verification must be an image or PDF document.' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Attachment is too large (max 8MB).' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FOPM prototype running at http://localhost:${PORT}`);
    console.log('Admin credentials are configured in data/db.json or through Admin Settings.');
  });
}

module.exports = { app, ensureState, hasValidFileSignature };

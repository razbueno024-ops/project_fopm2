// feed.js — renders a tower's concern feed in one of three distinct
// visual layouts (cards / timeline / ledger). Shared by the home hub
// and the standalone tower page so both stay in sync.

function statusBadge(status) {
  const labels = { new: 'New', 'in-progress': 'In progress', resolved: 'Resolved', open: 'Open', satisfied: 'Resolved' };
  const closed = status === 'resolved' || status === 'satisfied';
  return `<span class="badge ${closed ? 'badge-satisfied' : 'badge-open'}"><span class="badge-dot"></span>${labels[status] || 'New'}</span>`;
}

function towerChip(tower) {
  if (!tower) return '';
  return `<span class="tower-chip" style="--chip-accent:${tower.accent}">${tower.codename}</span>`;
}

// ---- Cards layout: photo-forward grid, for towers with a "showcase" feel ----
function renderCards(threads, opts) {
  return `<div class="feed-grid">${threads.map((t, i) => `
    <a class="feed-card fade-in" style="--tower-accent:${(opts.towerOf(t)||{}).accent||'#4C7EA8'}; animation-delay:${i*35}ms" href="/thread.html?token=${t.token}">
      ${t.thumbnail ? `<div class="feed-card-photo" style="background-image:url('${t.thumbnail}')"></div>` : `<div class="feed-card-photo feed-card-photo--empty">No photo</div>`}
      <div class="feed-card-body">
        <div class="feed-card-top">${opts.showChip ? towerChip(opts.towerOf(t)) : ''}${statusBadge(t.status)}</div>
        <div class="feed-card-title">${escapeHtml(t.title)}</div>
        <div class="feed-card-meta">${escapeHtml(t.submitterName || 'Anonymous')} · ${timeAgo(t.updatedAt)}</div>
      </div>
    </a>`).join('')}</div>`;
}

// ---- Timeline layout: chronological vertical line, for "broadcast" towers ----
function renderTimeline(threads, opts) {
  return `<div class="feed-timeline">${threads.map((t, i) => `
    <a class="timeline-item fade-in" style="--tower-accent:${(opts.towerOf(t)||{}).accent||'#4C7EA8'}; animation-delay:${i*35}ms" href="/thread.html?token=${t.token}">
      <div class="timeline-dot"></div>
      <div class="timeline-card">
        <div class="feed-card-top">${opts.showChip ? towerChip(opts.towerOf(t)) : ''}${statusBadge(t.status)}<span class="thread-meta" style="margin-left:auto;">${timeAgo(t.updatedAt)}</span></div>
        <div class="feed-card-title">${escapeHtml(t.title)}</div>
        <div class="thread-meta">${escapeHtml(t.submitterName || 'Anonymous')} · ${t.messageCount} message${t.messageCount===1?'':'s'}</div>
        ${t.preview ? `<div class="timeline-preview">${escapeHtml(t.preview)}${t.preview.length>=140?'…':''}</div>` : ''}
      </div>
    </a>`).join('')}</div>`;
}

// ---- Ledger layout: dense numbered rows, for "structural" towers ----
function renderLedger(threads, opts) {
  return `<div class="feed-ledger">
    <div class="ledger-head">
      <span>#</span><span>Concern</span><span>${opts.showChip ? 'Tower' : 'Reported by'}</span><span>Updated</span><span>Status</span>
    </div>
    ${threads.map((t, i) => `
    <a class="ledger-row fade-in" style="--tower-accent:${(opts.towerOf(t)||{}).accent||'#4C7EA8'}; animation-delay:${i*20}ms" href="/thread.html?token=${t.token}">
      <span class="mono ledger-index">${String(i+1).padStart(2,'0')}</span>
      <span class="ledger-title">${escapeHtml(t.title)}</span>
      <span class="ledger-sub">${opts.showChip ? towerChip(opts.towerOf(t)) : escapeHtml(t.submitterName || 'Anonymous')}</span>
      <span class="mono ledger-sub">${timeAgo(t.updatedAt)}</span>
      <span>${statusBadge(t.status)}</span>
    </a>`).join('')}
  </div>`;
}

const LAYOUT_RENDERERS = { cards: renderCards, timeline: renderTimeline, ledger: renderLedger };

/**
 * @param threads array of thread summaries (from /api/towers/:id/threads or merged)
 * @param layout 'cards' | 'timeline' | 'ledger'
 * @param opts { showChip: bool, towerOf: fn(thread) => tower }
 */
function renderFeed(threads, layout, opts) {
  if (!threads.length) {
    return `<div class="empty-state fade-in"><div class="glyph">🏗️</div>No concerns raised here yet. Be the first to file one.</div>`;
  }
  const renderer = LAYOUT_RENDERERS[layout] || renderCards;
  return renderer(threads, opts);
}

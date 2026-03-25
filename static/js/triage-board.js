/**
 * Triage Board — Variant B (v2)
 * Emails organized into 3 buckets with urgency scoring. No timestamps shown.
 * Uses real Gmail API data via /api/bulletin/emails.
 */

let tbAllThreads = [];
let tbFiltered = [];
let tbBucketOverrides = {};  // threadId -> bucket override from user moves
let tbActiveTag = 'all';
let tbCurrentThread = null;
let tbNextPageToken = null;
let tbCurrentQuery = '';
let tbReplyMode = 'reply'; // 'reply' | 'reply-all'

const TB_BUCKETS = ['reply', 'schedule', 'fyi'];
const TB_BUCKET_META = {
    reply: { title: 'Needs Reply', order: 0 },
    schedule: { title: 'To Schedule', order: 1 },
    fyi: { title: 'FYI / No Action', order: 2 },
};

const TB_EMPTY_STATES = {
    reply: '✓ All caught up',
    schedule: '📅 Nothing to schedule',
    fyi: '📋 Nothing to review',
};

// ── Boot ────────────────────────────────────────────────────────
tbLoadEmails();

document.getElementById('tb-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') tbLoadEmails(document.getElementById('tb-search').value.trim());
});
document.getElementById('tb-detail-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('tb-detail-modal')) tbCloseDetail();
});

// ── Auto-refresh every 60 seconds ───────────────────────────────
setInterval(() => {
    const q = tbCurrentQuery || 'in:inbox';
    fetch(`/api/bulletin/emails?q=${encodeURIComponent(q)}&max=50`)
        .then(r => r.json())
        .then(data => {
            const newThreads = data.threads || data || [];
            if (newThreads.error) return;
            const existingIds = new Set(tbAllThreads.map(t => t.threadId));
            const freshIds = new Set(newThreads.map(t => t.threadId));
            const newCount = [...freshIds].filter(id => !existingIds.has(id)).length;
            if (newCount > 0) {
                const banner = document.getElementById('tb-new-banner');
                const countEl = document.getElementById('tb-new-count');
                if (banner && countEl) {
                    countEl.textContent = newCount;
                    banner.classList.add('visible');
                }
            }
        })
        .catch(() => {});
}, 60000);

// ── Toast helper ────────────────────────────────────────────────
function showToast(message, type = 'default') {
    let container = document.getElementById('v2-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'v2-toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'v2-toast' + (type !== 'default' ? ' ' + type : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// ── Skeleton rows helper ─────────────────────────────────────────
function tbSkeletonRows(n) {
    return Array.from({ length: n }, () => `
        <div class="skeleton-row">
            <div class="skeleton-avatar"></div>
            <div class="skeleton-lines">
                <div class="skeleton-line medium"></div>
                <div class="skeleton-line short"></div>
                <div class="skeleton-line full"></div>
            </div>
        </div>
    `).join('');
}

// ── Load real email data ────────────────────────────────────────
function tbLoadEmails(query) {
    tbCurrentQuery = (query !== undefined ? query : (document.getElementById('tb-search').value || '')).trim();

    // Hide new-email banner
    const banner = document.getElementById('tb-new-banner');
    if (banner) banner.classList.remove('visible');

    tbSetAiStatus('Waiting for AI scoring...');

    TB_BUCKETS.forEach(b => {
        document.getElementById(`tb-body-${b}`).innerHTML = tbSkeletonRows(6);
    });

    const q = tbCurrentQuery || 'in:inbox';
    fetch(`/api/bulletin/emails?q=${encodeURIComponent(q)}&max=50`)
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                TB_BUCKETS.forEach(b => {
                    document.getElementById(`tb-body-${b}`).innerHTML = `<div class="tb-empty">⚠ ${escHtml(data.error)}</div>`;
                });
                return;
            }
            const threads = data.threads || data || [];
            tbNextPageToken = data.nextPageToken || null;
            tbAllThreads = threads.map(t => enrichThread(t));
            tbFilterEmails();
            tbApplyAiScores();
            tbUpdateLoadMore();
        })
        .catch(err => {
            TB_BUCKETS.forEach(b => {
                document.getElementById(`tb-body-${b}`).innerHTML = `<div class="tb-empty">Error: ${escHtml(err.message)}</div>`;
            });
            tbSetAiStatus('AI scoring unavailable');
        });
}

// ── Load more ────────────────────────────────────────────────────
function tbUpdateLoadMore() {
    let loadMoreArea = document.getElementById('tb-load-more-area');
    if (!loadMoreArea) {
        loadMoreArea = document.createElement('div');
        loadMoreArea.id = 'tb-load-more-area';
        loadMoreArea.style.padding = '8px 16px';
        const columns = document.querySelector('.tb-columns');
        if (columns) columns.parentNode.insertBefore(loadMoreArea, columns.nextSibling);
    }
    if (tbNextPageToken) {
        loadMoreArea.innerHTML = `<button class="v2-load-more" onclick="tbLoadMore()">Load more emails</button>`;
    } else {
        loadMoreArea.innerHTML = '';
    }
}

function tbLoadMore() {
    if (!tbNextPageToken) return;
    const q = tbCurrentQuery || 'in:inbox';
    fetch(`/api/emails/more?q=${encodeURIComponent(q)}&max=40&pageToken=${encodeURIComponent(tbNextPageToken)}`)
        .then(r => r.json())
        .then(data => {
            if (data.error) { showToast('Error loading more: ' + data.error, 'error'); return; }
            tbNextPageToken = data.nextPageToken || null;
            const newEmails = data.emails || [];
            // Convert flat emails to thread-like objects and append
            const newThreads = newEmails.map(e => enrichThread({
                threadId: e.threadId,
                subject: e.subject,
                participants: [{ name: e.from_name, email: e.from_email }],
                snippet: e.snippet,
                messages: [e],
                latest_date: e.date,
                labels: e.labels,
                hasAttachments: e.hasAttachments,
                isUnread: (e.labels || []).includes('UNREAD'),
                category: '',
            }));
            tbAllThreads = [...tbAllThreads, ...newThreads];
            tbFilterEmails();
            tbUpdateLoadMore();
        })
        .catch(err => showToast('Error: ' + err.message, 'error'));
}

// ── Enrich thread with tags + urgency + bucket ──────────────────
function enrichThread(thread) {
    const fromEmail = (thread.participants?.[0]?.email || '').toLowerCase();

    const tags = ['Direct'];

    const text = ((thread.subject || '') + ' ' + (thread.snippet || '')).toLowerCase();
    if (['edu', 'org'].some(tld => fromEmail.endsWith('.' + tld)) ||
        ['professor', 'prof', 'class', 'assignment', 'grade', 'office', 'ta '].some(w => text.includes(w))) {
        tags.push('Work');
    }

    // Preserve STARRED label from any message in thread
    const isStarred = (thread.labels || []).includes('STARRED') ||
        (thread.messages || []).some(m => (m.labels || []).includes('STARRED'));
    if (isStarred && !tags.includes('STARRED')) tags.push('STARRED');

    const urgencyStars = 1;
    const bucket = tbBucketOverrides[thread.threadId] || 'fyi';

    return {
        ...thread,
        tags,
        urgencyStars,
        bucket,
        heuristicUrgency: null,
        heuristicBucket: null,
        aiScored: false,
        aiReasons: [],
    };
}

function tbApplyAiScores() {
    const BATCH_SIZE = 15; // Match server cap to avoid timeouts
    const threadsPayload = tbAllThreads.map(t => ({
        threadId: t.threadId,
        subject: t.subject,
        snippet: t.snippet,
        from: t.participants?.[0]?.email || '',
        isUnread: !!t.isUnread,
        labels: t.labels || [],
        tags: t.tags || [],
        heuristicUrgency: t.heuristicUrgency,
        heuristicBucket: t.heuristicBucket,
    }));

    if (!threadsPayload.length) return;

    tbSetAiStatus('Scoring with Harvard AI...');

    // Score in batches then merge results
    const batches = [];
    for (let i = 0; i < threadsPayload.length; i += BATCH_SIZE) {
        batches.push(threadsPayload.slice(i, i + BATCH_SIZE));
    }

    Promise.all(batches.map(batch =>
        fetch('/api/triage/score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threads: batch }),
        }).then(r => r.json())
    ))
    .then(responses => {
        const byThreadId = {};
        let anyEnabled = false;
        let anyCached = true;

        for (const data of responses) {
            if (data.error && !data.enabled) continue; // completely disabled
            if (data.error) { tbSetAiStatus('AI scoring unavailable'); return; }
            anyEnabled = true;
            if (!data.cached) anyCached = false;
            (data.results || []).forEach(r => {
                if (r.threadId) byThreadId[r.threadId] = r;
            });
        }

        if (!anyEnabled) { tbSetAiStatus('AI scoring unavailable'); return; }

        tbAllThreads = tbAllThreads.map(t => {
            const scored = byThreadId[t.threadId];
            if (!scored) return t;
            const tags = (t.tags || []).filter(tag => !['Scheduling', 'Mailing list', 'Direct'].includes(tag));
            if (scored.bucket === 'schedule' && !tags.includes('Scheduling')) {
                tags.unshift('Scheduling');
            }
            tags.unshift(scored.isMailingList ? 'Mailing list' : 'Direct');
            if (t.tags.includes('STARRED') && !tags.includes('STARRED')) tags.push('STARRED');
            return {
                ...t,
                urgencyStars: scored.urgencyStars || 1,
                bucket: tbBucketOverrides[t.threadId] || scored.bucket || t.bucket,
                tags,
                aiScored: true,
                aiReasons: scored.reasons || [],
            };
        });

        tbSetAiStatus(anyCached ? 'AI scoring active (cached)' : 'AI scoring active', true);
        tbFilterEmails();
    })
    .catch(() => {
        tbSetAiStatus('AI scoring unavailable');
    });
}

function tbSetAiStatus(text, isOn = false) {
    const el = document.getElementById('tb-ai-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('on', !!isOn);
}

// ── Filter + render ─────────────────────────────────────────────
function tbFilterEmails() {
    const query = (document.getElementById('tb-search').value || '').toLowerCase().trim();
    const hideMl = document.getElementById('tb-hide-ml').checked;

    tbFiltered = tbAllThreads.filter(t => {
        if (query) {
            const haystack = ((t.subject || '') + ' ' + (t.snippet || '') + ' ' +
                (t.participants || []).map(p => (p.name || '') + ' ' + (p.email || '')).join(' ')).toLowerCase();
            if (!haystack.includes(query)) return false;
        }
        if (hideMl && t.tags.includes('Mailing list')) return false;
        if (tbActiveTag !== 'all' && !t.tags.includes(tbActiveTag)) return false;
        return true;
    });

    tbRenderBoard();
    tbUpdateTabTitle();
}

function tbSetTagFilter(tag) {
    tbActiveTag = tag;
    document.querySelectorAll('.tb-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === tag);
        btn.classList.toggle('v2-btn-secondary', btn.dataset.filter === tag);
        btn.classList.toggle('v2-btn-ghost', btn.dataset.filter !== tag);
    });
    tbFilterEmails();
}

function tbUpdateTabTitle() {
    const unread = tbAllThreads.filter(t => t.isUnread).length;
    document.title = unread > 0 ? `(${unread}) Triage Board` : 'Triage Board';
}

function tbRenderBoard() {
    const buckets = { reply: [], schedule: [], fyi: [] };

    tbFiltered.forEach(t => {
        const b = t.bucket || 'fyi';
        if (buckets[b]) buckets[b].push(t);
    });

    Object.keys(buckets).forEach(b => {
        buckets[b].sort((a, bx) => (bx.urgencyStars || 1) - (a.urgencyStars || 1));
    });

    TB_BUCKETS.forEach(b => {
        const body = document.getElementById(`tb-body-${b}`);
        const count = document.getElementById(`tb-count-${b}`);
        count.textContent = buckets[b].length;

        if (buckets[b].length === 0) {
            body.innerHTML = `<div class="tb-empty">${TB_EMPTY_STATES[b] || 'No emails here'}</div>`;
            return;
        }

        body.innerHTML = '';
        buckets[b].forEach(thread => {
            body.appendChild(tbCreateRow(thread, b));
        });
    });
}

// ── Create email row ────────────────────────────────────────────
function tbCreateRow(thread, currentBucket) {
    const row = document.createElement('div');
    row.className = 'tb-email-row' + (thread.isUnread ? ' unread' : '');
    row.dataset.threadId = thread.threadId;

    const sender = thread.participants?.[0];
    const initial = (sender?.name || sender?.email || '?')[0].toUpperCase();
    const color = strToColor(sender?.email);

    const stars = Math.max(1, Math.min(3, Number(thread.urgencyStars || 1)));
    const urgLevel = stars >= 3 ? 'high' : stars === 2 ? 'medium' : 'low';

    const moveOptions = TB_BUCKETS.filter(b => b !== currentBucket);
    const moveBtns = moveOptions.map(b => {
        const direction = TB_BUCKET_META[b].order < TB_BUCKET_META[currentBucket].order ? '←' : '→';
        const label = `${direction} ${TB_BUCKET_META[b].title}`;
        return `<button class="tb-move-btn" onclick="event.stopPropagation(); tbMoveThread('${thread.threadId}', '${b}')">${label}</button>`;
    }).join('');

    const urgencyHint = thread.aiScored
        ? `AI urgency: ${stars} star${stars > 1 ? 's' : ''}${thread.aiReasons?.length ? ' - ' + thread.aiReasons.join('; ') : ''}`
        : 'AI urgency pending';

    const isStarred = (thread.tags || []).includes('STARRED');
    const email = thread.messages?.[0] || {};
    const attachIcon = thread.hasAttachments ? '<span class="v2-attach-icon">📎</span>' : '';

    row.innerHTML = `
        <button class="v2-star-btn ${isStarred ? 'starred' : ''}" onclick="event.stopPropagation(); tbToggleStar('${escHtml(thread.threadId)}', '${escHtml(email.id || '')}')">★</button>
        <div class="v2-avatar v2-avatar-sm" style="background:${color};margin-top:2px;">${initial}</div>
        <div class="tb-email-main">
            <div class="tb-email-top-row">
                ${thread.isUnread ? '<span class="v2-unread-dot"></span>' : ''}
                <span class="tb-email-sender">${escHtml(sender?.name || sender?.email)}</span>
                <span class="tb-urgency-score ${urgLevel}" title="${escHtml(urgencyHint)}">
                    ${stars === 3 ? '★★★' : stars === 2 ? '★★' : '★'}
                </span>
                ${attachIcon}
            </div>
            <div class="tb-email-subject">${escHtml(thread.subject)}</div>
            <div class="tb-email-snippet">${escHtml(thread.snippet)}</div>
        </div>
        <div class="tb-email-actions">${moveBtns}</div>`;

    row.addEventListener('click', () => tbOpenDetail(thread));
    return row;
}

// ── Star / unstar ────────────────────────────────────────────────
function tbToggleStar(threadId, messageId) {
    const thread = tbAllThreads.find(t => t.threadId === threadId);
    if (!thread) return;

    const isStarred = (thread.tags || []).includes('STARRED');
    const endpoint = isStarred ? '/api/email/unstar' : '/api/email/star';

    // Optimistic update
    if (isStarred) {
        thread.tags = thread.tags.filter(t => t !== 'STARRED');
    } else {
        thread.tags = [...(thread.tags || []), 'STARRED'];
    }
    tbRenderBoard();

    const mid = messageId || (thread.messages?.[0]?.id);
    if (!mid) return;

    fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: mid }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) {
            // Revert optimistic update
            if (isStarred) {
                thread.tags = [...(thread.tags || []), 'STARRED'];
            } else {
                thread.tags = thread.tags.filter(t => t !== 'STARRED');
            }
            tbRenderBoard();
            showToast('Error: ' + data.error, 'error');
        } else {
            showToast(isStarred ? 'Unstarred' : 'Starred');
        }
    })
    .catch(err => {
        showToast('Error: ' + err.message, 'error');
    });
}

// ── Move thread between buckets ─────────────────────────────────
function tbMoveThread(threadId, newBucket) {
    tbBucketOverrides[threadId] = newBucket;

    // Animate the row out (optimistic)
    const row = document.querySelector(`.tb-email-row[data-thread-id="${threadId}"]`);
    if (row) {
        row.style.opacity = '0';
        row.style.transform = 'translateX(8px)';
        row.style.transition = 'all 0.15s ease';
    }

    setTimeout(() => {
        tbAllThreads = tbAllThreads.map(t => {
            if (t.threadId === threadId) {
                return { ...t, bucket: newBucket };
            }
            return t;
        });
        tbFilterEmails();
    }, 150);
}

// ── Email detail modal ──────────────────────────────────────────
function tbOpenDetail(thread) {
    tbCurrentThread = thread;
    tbReplyMode = 'reply';

    if (thread.isUnread) {
        fetch('/api/email/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: thread.threadId }),
        }).catch(() => {});
        thread.isUnread = false;
        tbRenderBoard();
        tbUpdateTabTitle();
    }

    const sender = thread.participants?.[0];
    const content = document.getElementById('tb-detail-content');

    content.innerHTML = `
        <div class="tb-modal-subject">${escHtml(thread.subject)}</div>
        <div class="tb-modal-meta">
            <div class="v2-avatar v2-avatar-sm" style="background:${strToColor(sender?.email)}">${(sender?.name || sender?.email || '?')[0].toUpperCase()}</div>
            <span>${escHtml(sender?.name || sender?.email)}</span>
        </div>
        <div class="tb-modal-actions">
            <button class="v2-btn v2-btn-sm v2-btn-secondary" onclick="tbMarkUnread()">Mark Unread</button>
            <button class="v2-btn v2-btn-sm v2-btn-danger" onclick="tbDeleteThread()">Delete</button>
        </div>
        <div class="tb-modal-body" id="tb-modal-body">
            <div class="v2-loading"><div class="v2-spinner"></div><span>Loading…</span></div>
        </div>
        <div class="tb-modal-reply">
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                <button class="v2-btn v2-btn-sm ${tbReplyMode === 'reply' ? 'v2-btn-secondary' : 'v2-btn-ghost'}" id="tb-reply-btn" onclick="tbSetReplyMode('reply')">Reply</button>
                <button class="v2-btn v2-btn-sm ${tbReplyMode === 'reply-all' ? 'v2-btn-secondary' : 'v2-btn-ghost'}" id="tb-reply-all-btn" onclick="tbSetReplyMode('reply-all')">Reply All</button>
            </div>
            <textarea id="tb-reply-text" class="v2-textarea" rows="3" placeholder="Write a reply…"></textarea>
            <div style="display:flex;gap:6px;justify-content:flex-end;">
                <button class="v2-btn v2-btn-primary v2-btn-sm" onclick="tbSendReply()">Send Reply</button>
            </div>
        </div>`;

    document.getElementById('tb-detail-modal').style.display = 'flex';

    fetch(`/api/bulletin/thread/${thread.threadId}`)
        .then(r => r.json())
        .then(messages => {
            document.getElementById('tb-modal-body').innerHTML = messages.map(msg => `
                <div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border);">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                        <div class="v2-avatar v2-avatar-sm" style="background:${strToColor(msg.from_email)}">${(msg.from_name || msg.from_email)[0].toUpperCase()}</div>
                        <span style="font-weight:500;font-size:13px;">${escHtml(msg.from_name || msg.from_email)}</span>
                        ${msg.hasAttachments ? '<span class="v2-attach-icon">📎</span>' : ''}
                    </div>
                    <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;color:var(--text-secondary);">${escHtml(msg.body || msg.snippet)}</div>
                </div>
            `).join('');
        })
        .catch(err => {
            document.getElementById('tb-modal-body').innerHTML = `<div style="color:var(--danger);">Error: ${escHtml(err.message)}</div>`;
        });
}

function tbSetReplyMode(mode) {
    tbReplyMode = mode;
    const replyBtn = document.getElementById('tb-reply-btn');
    const replyAllBtn = document.getElementById('tb-reply-all-btn');
    if (replyBtn) {
        replyBtn.className = `v2-btn v2-btn-sm ${mode === 'reply' ? 'v2-btn-secondary' : 'v2-btn-ghost'}`;
    }
    if (replyAllBtn) {
        replyAllBtn.className = `v2-btn v2-btn-sm ${mode === 'reply-all' ? 'v2-btn-secondary' : 'v2-btn-ghost'}`;
    }
}

function tbCloseDetail() {
    document.getElementById('tb-detail-modal').style.display = 'none';
    tbCurrentThread = null;
}

function tbMarkUnread() {
    if (!tbCurrentThread) return;
    fetch('/api/email/mark-unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: tbCurrentThread.threadId }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        tbCurrentThread.isUnread = true;
        tbCloseDetail();
        tbRenderBoard();
        tbUpdateTabTitle();
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

function tbDeleteThread() {
    if (!tbCurrentThread) return;
    if (!confirm('Move this conversation to trash?')) return;
    fetch('/api/email/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: tbCurrentThread.threadId }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        tbAllThreads = tbAllThreads.filter(t => t.threadId !== tbCurrentThread.threadId);
        tbCloseDetail();
        tbFilterEmails();
        showToast('Conversation moved to trash');
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

function tbSendReply() {
    if (!tbCurrentThread) return;
    const text = document.getElementById('tb-reply-text')?.value?.trim();
    if (!text) return;

    let to;
    if (tbReplyMode === 'reply-all') {
        to = (tbCurrentThread.participants || []).map(p => p.email).filter(Boolean).join(', ');
    } else {
        to = tbCurrentThread.participants?.[0]?.email || '';
    }

    fetch('/api/bulletin/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            to,
            subject: 'Re: ' + tbCurrentThread.subject,
            body: text,
            threadId: tbCurrentThread.threadId,
        }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        document.getElementById('tb-reply-text').value = '';
        showToast('Reply sent!', 'success');
        tbCloseDetail();
        tbLoadEmails();
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

// ── Compose ──────────────────────────────────────────────────────
function tbOpenCompose() {
    const modal = document.getElementById('tb-compose-modal');
    if (!modal) return;
    document.getElementById('tb-compose-to').value = '';
    document.getElementById('tb-compose-subject').value = '';
    document.getElementById('tb-compose-body').value = '';
    modal.style.display = 'flex';
}

function tbCloseCompose() {
    const modal = document.getElementById('tb-compose-modal');
    if (modal) modal.style.display = 'none';
}

function tbSendCompose() {
    const to = document.getElementById('tb-compose-to').value.trim();
    const subject = document.getElementById('tb-compose-subject').value.trim();
    const body = document.getElementById('tb-compose-body').value.trim();
    if (!to || !subject || !body) { showToast('Please fill in all fields', 'error'); return; }

    fetch('/api/bulletin/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        tbCloseCompose();
        showToast('Email sent!', 'success');
        tbLoadEmails();
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

// ── Helpers ─────────────────────────────────────────────────────
function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}
function strToColor(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${Math.abs(hash) % 360}, 50%, 45%)`;
}

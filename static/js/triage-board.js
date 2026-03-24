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

const TB_BUCKETS = ['reply', 'schedule', 'fyi'];
const TB_BUCKET_META = {
    reply: { title: 'Needs Reply', order: 0 },
    schedule: { title: 'To Schedule', order: 1 },
    fyi: { title: 'FYI / No Action', order: 2 },
};

// Heuristic keyword fallbacks are intentionally disabled in AI-only mode.
// const SCHEDULING_KW = ['meet', 'meeting', 'schedule', 'calendar', 'availability', 'available', 'free', 'slot', 'time', 'zoom', 'call', 'sync', 'office hours', 'book', 'reschedule', 'coffee', 'lunch'];
// const QUESTION_KW = ['?', 'question', 'help', 'how do', 'can you', 'could you', 'would you', 'please', 'wondering', 'thoughts on'];
// const URGENCY_KW = ['asap', 'urgent', 'by tomorrow', 'deadline', 'due', 'eod', 'end of day', 'today', 'immediately', 'critical', 'time-sensitive'];

// ── Boot ────────────────────────────────────────────────────────
tbLoadEmails();

document.getElementById('tb-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') tbFilterEmails();
});
document.getElementById('tb-detail-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('tb-detail-modal')) tbCloseDetail();
});

// ── Load real email data ────────────────────────────────────────
function tbLoadEmails() {
    tbSetAiStatus('Waiting for AI scoring...');

    TB_BUCKETS.forEach(b => {
        document.getElementById(`tb-body-${b}`).innerHTML = '<div class="v2-loading"><div class="v2-spinner"></div></div>';
    });

    fetch('/api/bulletin/emails?q=in%3Ainbox&max=50')
        .then(r => r.json())
        .then(threads => {
            if (threads.error) {
                TB_BUCKETS.forEach(b => {
                    document.getElementById(`tb-body-${b}`).innerHTML = `<div class="tb-empty">⚠ ${escHtml(threads.error)}</div>`;
                });
                return;
            }
            tbAllThreads = threads.map(t => enrichThread(t));
            tbFilterEmails();
            tbApplyAiScores();
        })
        .catch(err => {
            TB_BUCKETS.forEach(b => {
                document.getElementById(`tb-body-${b}`).innerHTML = `<div class="tb-empty">Error: ${escHtml(err.message)}</div>`;
            });
            tbSetAiStatus('AI scoring unavailable');
        });
}

// ── Enrich thread with tags + urgency + bucket ──────────────────
function enrichThread(thread) {
    const fromEmail = (thread.participants?.[0]?.email || '').toLowerCase();

    // AI sets Mailing list vs Direct, so start with a neutral direct default.
    const tags = ['Direct'];

    // Detect work-related context from sender/domain and common org terms.
    const text = ((thread.subject || '') + ' ' + (thread.snippet || '')).toLowerCase();
    if (['edu', 'org'].some(tld => fromEmail.endsWith('.' + tld)) ||
        ['professor', 'prof', 'class', 'assignment', 'grade', 'office', 'ta '].some(w => text.includes(w))) {
        tags.push('Work');
    }

    // AI-only mode: thread starts neutral until AI score arrives.
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

    fetch('/api/triage/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threads: threadsPayload }),
    })
        .then(r => r.json())
        .then(data => {
            if (!data.enabled || data.error) {
                tbSetAiStatus('AI scoring unavailable');
                return;
            }

            const byThreadId = {};
            (data.results || []).forEach(r => {
                if (r.threadId) byThreadId[r.threadId] = r;
            });

            tbAllThreads = tbAllThreads.map(t => {
                const scored = byThreadId[t.threadId];
                if (!scored) return t;
                const tags = (t.tags || []).filter(tag => !['Scheduling', 'Mailing list', 'Direct'].includes(tag));
                if (scored.bucket === 'schedule' && !tags.includes('Scheduling')) {
                    tags.unshift('Scheduling');
                }
                tags.unshift(scored.isMailingList ? 'Mailing list' : 'Direct');
                return {
                    ...t,
                    urgencyStars: scored.urgencyStars || 1,
                    bucket: tbBucketOverrides[t.threadId] || scored.bucket || t.bucket,
                    tags,
                    aiScored: true,
                    aiReasons: scored.reasons || [],
                };
            });

            tbSetAiStatus(data.cached ? 'AI scoring active (cached)' : 'AI scoring active', true);
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
        // Search filter
        if (query) {
            const haystack = ((t.subject || '') + ' ' + (t.snippet || '') + ' ' +
                (t.participants || []).map(p => (p.name || '') + ' ' + (p.email || '')).join(' ')).toLowerCase();
            if (!haystack.includes(query)) return false;
        }
        // Hide mailing lists
        if (hideMl && t.tags.includes('Mailing list')) return false;
        // Tag filter
        if (tbActiveTag !== 'all' && !t.tags.includes(tbActiveTag)) return false;
        return true;
    });

    tbRenderBoard();
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

function tbRenderBoard() {
    const buckets = { reply: [], schedule: [], fyi: [] };

    tbFiltered.forEach(t => {
        const b = t.bucket || 'fyi';
        if (buckets[b]) buckets[b].push(t);
    });

    // Sort each bucket by urgency descending (stable)
    Object.keys(buckets).forEach(b => {
        buckets[b].sort((a, bx) => (bx.urgencyStars || 1) - (a.urgencyStars || 1));
    });

    TB_BUCKETS.forEach(b => {
        const body = document.getElementById(`tb-body-${b}`);
        const count = document.getElementById(`tb-count-${b}`);
        count.textContent = buckets[b].length;

        if (buckets[b].length === 0) {
            body.innerHTML = '<div class="tb-empty">No emails here</div>';
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

    const sender = thread.participants?.[0];
    const initial = (sender?.name || sender?.email || '?')[0].toUpperCase();
    const color = strToColor(sender?.email);

    const stars = Math.max(1, Math.min(3, Number(thread.urgencyStars || 1)));
    const urgLevel = stars >= 3 ? 'high' : stars === 2 ? 'medium' : 'low';

    // Move buttons (show other 2 buckets)
    const moveOptions = TB_BUCKETS.filter(b => b !== currentBucket);
    const moveBtns = moveOptions.map(b => {
        const direction = TB_BUCKET_META[b].order < TB_BUCKET_META[currentBucket].order ? '←' : '→';
        const label = `${direction} ${TB_BUCKET_META[b].title}`;
        return `<button class="tb-move-btn" onclick="event.stopPropagation(); tbMoveThread('${thread.threadId}', '${b}')">${label}</button>`;
    }).join('');

    const urgencyHint = thread.aiScored
        ? `AI urgency: ${stars} star${stars > 1 ? 's' : ''}${thread.aiReasons?.length ? ' - ' + thread.aiReasons.join('; ') : ''}`
        : 'AI urgency pending';

    row.innerHTML = `
        <div class="v2-avatar v2-avatar-sm" style="background:${color};margin-top:2px;">${initial}</div>
        <div class="tb-email-main">
            <div class="tb-email-top-row">
                ${thread.isUnread ? '<span class="v2-unread-dot"></span>' : ''}
                <span class="tb-email-sender">${escHtml(sender?.name || sender?.email)}</span>
                <span class="tb-urgency-score ${urgLevel}" title="${escHtml(urgencyHint)}">
                    ${stars === 3 ? '★★★' : stars === 2 ? '★★' : '★'}
                </span>
            </div>
            <div class="tb-email-subject">${escHtml(thread.subject)}</div>
            <div class="tb-email-snippet">${escHtml(thread.snippet)}</div>
        </div>
        <div class="tb-email-actions">${moveBtns}</div>`;

    row.addEventListener('click', () => tbOpenDetail(thread));
    return row;
}

// ── Move thread between buckets ─────────────────────────────────
function tbMoveThread(threadId, newBucket) {
    tbBucketOverrides[threadId] = newBucket;
    // Re-enrich and re-render
    tbAllThreads = tbAllThreads.map(t => {
        if (t.threadId === threadId) {
            return { ...t, bucket: newBucket };
        }
        return t;
    });
    tbFilterEmails();
}

// ── Email detail modal ──────────────────────────────────────────
function tbOpenDetail(thread) {
    tbCurrentThread = thread;

    // Mark as read
    if (thread.isUnread) {
        fetch('/api/email/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: thread.threadId }),
        }).catch(() => {});
        thread.isUnread = false;
        tbRenderBoard();
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
            <textarea id="tb-reply-text" class="v2-textarea" rows="3" placeholder="Write a reply…"></textarea>
            <div style="display:flex;gap:6px;justify-content:flex-end;">
                <button class="v2-btn v2-btn-primary v2-btn-sm" onclick="tbSendReply()">Send Reply</button>
            </div>
        </div>`;

    document.getElementById('tb-detail-modal').style.display = 'flex';

    // Fetch full thread
    fetch(`/api/bulletin/thread/${thread.threadId}`)
        .then(r => r.json())
        .then(messages => {
            document.getElementById('tb-modal-body').innerHTML = messages.map(msg => `
                <div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border);">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                        <div class="v2-avatar v2-avatar-sm" style="background:${strToColor(msg.from_email)}">${(msg.from_name || msg.from_email)[0].toUpperCase()}</div>
                        <span style="font-weight:500;font-size:13px;">${escHtml(msg.from_name || msg.from_email)}</span>
                    </div>
                    <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;color:var(--text-secondary);">${escHtml(msg.body || msg.snippet)}</div>
                </div>
            `).join('');
        })
        .catch(err => {
            document.getElementById('tb-modal-body').innerHTML = `<div style="color:var(--danger);">Error: ${escHtml(err.message)}</div>`;
        });
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
        if (data.error) { alert('Error: ' + data.error); return; }
        tbCurrentThread.isUnread = true;
        tbCloseDetail();
        tbRenderBoard();
    })
    .catch(err => alert('Error: ' + err.message));
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
        if (data.error) { alert('Error: ' + data.error); return; }
        tbAllThreads = tbAllThreads.filter(t => t.threadId !== tbCurrentThread.threadId);
        tbCloseDetail();
        tbFilterEmails();
    })
    .catch(err => alert('Error: ' + err.message));
}

function tbSendReply() {
    if (!tbCurrentThread) return;
    const text = document.getElementById('tb-reply-text')?.value?.trim();
    if (!text) return;

    const to = tbCurrentThread.participants?.map(p => p.email).filter(Boolean).join(', ');

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
        if (data.error) { alert('Error: ' + data.error); return; }
        document.getElementById('tb-reply-text').value = '';
        alert('Reply sent!');
        tbCloseDetail();
        tbLoadEmails();
    })
    .catch(err => alert('Error: ' + err.message));
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

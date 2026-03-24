/**
 * Scheduling Assist — Variant A (v2)
 * Inbox + email detail + contextual scheduling panel using real Gmail/Calendar APIs.
 */

let saAllEmails = [];
let saSelectedEmail = null;
let saSelectedSlots = new Set();
let saMyEvents = null;
let saShowExpanded = false;
let saPrivacyDetailed = false;
let saCreateHolds = false;
let saMeetingDurationMins = 30;
let saNextPageToken = null;
let saReplyMode = 'reply'; // 'reply' | 'reply-all'
// Intent cache by message id so inbox/detail views stay consistent without re-requesting.
const saIntentByEmailId = new Map();
// Tracks in-flight intent requests by message id to avoid duplicate concurrent calls.
const saIntentRequests = new Map();

const SCHEDULING_KEYWORDS = [
    'meet', 'meeting', 'schedule', 'calendar', 'availability',
    'available', 'free', 'slot', 'time', 'catch up', 'coffee',
    'lunch', 'call', 'zoom', 'sync', 'office hours', 'book',
    'when are you', 'let\'s find', 'propose', 'reschedule', 'soon'
];

// ── Boot ────────────────────────────────────────────────────────
saLoadInbox();

document.getElementById('sa-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') saLoadInbox();
});

// ── Auto-refresh every 60 seconds ───────────────────────────────
setInterval(() => {
    const q = document.getElementById('sa-search').value.trim();
    const query = q ? encodeURIComponent(q) : 'in%3Ainbox';
    fetch(`/api/calendar-email/emails?q=${query}&max=40`)
        .then(r => r.json())
        .then(data => {
            const newEmails = data.emails || data || [];
            if (newEmails.error) return;
            const existingIds = new Set(saAllEmails.map(e => e.id));
            const newCount = newEmails.filter(e => !existingIds.has(e.id)).length;
            if (newCount > 0) {
                const banner = document.getElementById('sa-new-banner');
                const countEl = document.getElementById('sa-new-count');
                if (banner && countEl) {
                    countEl.textContent = newCount;
                    banner.classList.add('visible');
                }
            }
        })
        .catch(() => {});
}, 60000);

// ── Toast helper ─────────────────────────────────────────────────
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
    setTimeout(() => toast.remove(), 3000);
}

// ── Skeleton rows helper ─────────────────────────────────────────
function saSkeletonRows(n) {
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
document.getElementById('sa-compose-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('sa-compose-modal')) saCloseComposer();
});

// ── Inbox ───────────────────────────────────────────────────────
function saLoadInbox() {
    const list = document.getElementById('sa-inbox-list');
    list.innerHTML = saSkeletonRows(8);

    const banner = document.getElementById('sa-new-banner');
    if (banner) banner.classList.remove('visible');

    const q = document.getElementById('sa-search').value.trim();
    const query = q ? encodeURIComponent(q) : 'in%3Ainbox';

    fetch(`/api/calendar-email/emails?q=${query}&max=40`)
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                list.innerHTML = `<div class="v2-loading"><span>⚠ ${escHtml(data.error)}</span></div>`;
                return;
            }
            // API now returns {emails: [...], nextPageToken: ...}
            saAllEmails = data.emails || data || [];
            saNextPageToken = data.nextPageToken || null;
            saRenderInbox();
            saPrimeIntentDetection();
            saUpdateTabTitle();
        })
        .catch(err => {
            list.innerHTML = `<div class="v2-loading"><span>Error: ${escHtml(err.message)}</span></div>`;
        });
}

function saLoadMore() {
    if (!saNextPageToken) return;
    const q = document.getElementById('sa-search').value.trim() || 'in:inbox';
    fetch(`/api/emails/more?q=${encodeURIComponent(q)}&max=40&pageToken=${encodeURIComponent(saNextPageToken)}`)
        .then(r => r.json())
        .then(data => {
            if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
            saNextPageToken = data.nextPageToken || null;
            saAllEmails = [...saAllEmails, ...(data.emails || [])];
            saRenderInbox();
        })
        .catch(err => showToast('Error: ' + err.message, 'error'));
}

function saUpdateTabTitle() {
    const unread = saAllEmails.filter(e => (e.labels || []).includes('UNREAD')).length;
    document.title = unread > 0 ? `(${unread}) Scheduling Assist` : 'Scheduling Assist';
}

function saRenderInbox() {
    const list = document.getElementById('sa-inbox-list');
    list.innerHTML = '';

    saAllEmails.forEach(email => {
        const row = document.createElement('div');
        const isUnread = (email.labels || []).includes('UNREAD');
        const isStarred = (email.labels || []).includes('STARRED');
        row.className = 'sa-email-row' +
            (saSelectedEmail?.id === email.id ? ' selected' : '') +
            (isUnread ? ' unread' : '');

        const initial = (email.from_name || email.from_email || '?')[0].toUpperCase();
        const color = strToColor(email.from_email);
        const intentInfo = saIntentByEmailId.get(email.id);
        const hasSchedulingIntent = intentInfo?.isScheduling === true;
        const isAnalyzingIntent = !intentInfo;

        let tagsHtml = '';
        if (hasSchedulingIntent) {
            tagsHtml = `<div class="sa-email-tags"><span class="sa-intent-badge">📅 Scheduling (${escHtml(intentInfo.source || 'ai')})</span></div>`;
        } else if (isAnalyzingIntent) {
            tagsHtml = '<div class="sa-email-tags"><span class="sa-intent-badge" style="opacity:.7;">AI intent check…</span></div>';
        }

        const attachIcon = email.hasAttachments ? '<span class="v2-attach-icon" title="Has attachments">📎</span>' : '';

        row.innerHTML = `
            <div class="v2-avatar" style="background:${color}">${initial}</div>
            <div class="sa-email-info">
                <div class="sa-email-top">
                    <span class="sa-email-sender">${isUnread ? '<span class="v2-unread-dot"></span> ' : ''}${escHtml(email.from_name || email.from_email)}</span>
                    <span style="display:flex;align-items:center;gap:4px;">${attachIcon}<span class="sa-email-date">${fmtDate(email.date)}</span></span>
                </div>
                <div class="sa-email-subject">${escHtml(email.subject)}</div>
                <div class="sa-email-snippet">${escHtml(email.snippet)}</div>
                ${tagsHtml}
            </div>
            <button class="v2-star-btn${isStarred ? ' starred' : ''}" title="${isStarred ? 'Unstar' : 'Star'}" onclick="saToggleStar(event, '${escAttr(email.id)}')">★</button>`;

        row.addEventListener('click', () => saShowDetail(email));
        list.appendChild(row);
    });

    // Load more button
    if (saNextPageToken) {
        const btn = document.createElement('button');
        btn.className = 'v2-btn v2-btn-ghost v2-load-more';
        btn.textContent = 'Load more…';
        btn.onclick = saLoadMore;
        list.appendChild(btn);
    }
}

// ── Star toggle ──────────────────────────────────────────────────
function saToggleStar(event, emailId) {
    event.stopPropagation();
    const email = saAllEmails.find(e => e.id === emailId);
    if (!email) return;
    const isStarred = (email.labels || []).includes('STARRED');
    const endpoint = isStarred ? '/api/email/unstar' : '/api/email/star';
    // Optimistic update
    if (isStarred) {
        email.labels = (email.labels || []).filter(l => l !== 'STARRED');
    } else {
        email.labels = [...(email.labels || []), 'STARRED'];
    }
    saRenderInbox();
    fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: emailId }),
    })
    .then(r => r.json())
    .then(data => { if (data.error) { showToast('Star error: ' + data.error, 'error'); } })
    .catch(() => { showToast('Could not update star', 'error'); });
}

// ── Scheduling intent detection ─────────────────────────────────
function detectSchedulingIntentHeuristic(email) {
    const text = ((email.subject || '') + ' ' + (email.snippet || '') + ' ' + (email.body || '')).toLowerCase();
    return SCHEDULING_KEYWORDS.some(kw => text.includes(kw));
}

function saPrimeIntentDetection(limit = 12) {
    // Warm intent results for first visible emails to reduce waiting after click.
    saAllEmails.slice(0, limit).forEach(email => {
        saGetSchedulingIntent(email)
            .then(() => saRenderInbox())
            .catch(() => {});
    });
}

function saGetSchedulingIntent(email) {
    const id = email?.id;
    if (!id) {
        return Promise.resolve({
            isScheduling: false,
            confidence: 'low',
            source: 'ai-unavailable',
            reason: 'Missing email id for AI intent request.',
        });
    }

    if (saIntentByEmailId.has(id)) {
        return Promise.resolve(saIntentByEmailId.get(id));
    }
    // Reuse the same promise if this email is already being classified.
    if (saIntentRequests.has(id)) {
        return saIntentRequests.get(id);
    }

    // Primary path: ask backend AI classifier for scheduling intent.
    const req = fetch('/api/scheduling-assist/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: {
                id,
                subject: email.subject || '',
                snippet: email.snippet || '',
                body: email.body || '',
            },
        }),
    })
    .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            throw new Error(data.error || `Intent API failed (${r.status})`);
        }
        // Normalize server response shape for UI use.
        const intentInfo = {
            isScheduling: data.isScheduling === true,
            confidence: data.confidence || 'low',
            source: data.source || 'ai',
            reason: data.reason || '',
        };
        saIntentByEmailId.set(id, intentInfo);
        return intentInfo;
    })
    .catch(() => {
        // Network-level failure: fall back to local keyword heuristic.
        const isScheduling = detectSchedulingIntentHeuristic(email);
        const fallback = {
            isScheduling,
            confidence: isScheduling ? 'medium' : 'low',
            source: 'heuristic',
            reason: 'AI unreachable; classified by keyword matching.',
        };
        saIntentByEmailId.set(id, fallback);
        return fallback;
    })
    .finally(() => {
        saIntentRequests.delete(id);
    });

    saIntentRequests.set(id, req);
    return req;
}

function saIntentBadgeHtml(intentInfo, checking) {
    if (checking) {
        return '<span class="v2-badge" style="margin-left:4px;">Checking scheduling intent…</span>';
    }
    if (!intentInfo?.isScheduling) {
        return '';
    }
    const sourceLabel = intentInfo.source === 'ai' ? 'AI' : 'heuristic';
    const reasonTitle = intentInfo.reason ? ` title="${escAttr(intentInfo.reason)}"` : '';
    return `<span class="v2-badge v2-badge-primary" style="margin-left:4px;"${reasonTitle}>Scheduling intent (${sourceLabel})</span>`;
}

// ── Email detail ────────────────────────────────────────────────
async function saShowDetail(email) {
    saSelectedEmail = email;
    // Switching to a different email always closes the scheduling panel.
    saClosePanel();

    // Mark as read
    if ((email.labels || []).includes('UNREAD')) {
        fetch('/api/email/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: email.id }),
        }).catch(() => {});
        email.labels = email.labels.filter(l => l !== 'UNREAD');
    }

    saRenderInbox();

    const panel = document.getElementById('sa-detail');
    // Render immediately with a loading badge while intent is being classified.
    panel.innerHTML = saBuildDetailHtml(email, null, true);

    const selectedId = email.id;
    const intentInfo = await saGetSchedulingIntent(email);
    // Guard against stale async result if user selected a different email meanwhile.
    if (!saSelectedEmail || saSelectedEmail.id !== selectedId) return;

    panel.innerHTML = saBuildDetailHtml(email, intentInfo, false);

    // Auto-open scheduling panel only when AI/fallback classifies as scheduling.
    if (intentInfo.isScheduling) {
        saOpenPanel(email.from_email, email.from_name);
    }
}

function saBuildDetailHtml(email, intentInfo, checkingIntent) {
    return `
        <div class="sa-detail-content">
            <div class="sa-detail-subject">${escHtml(email.subject)}</div>
            <div class="sa-detail-meta">
                <div class="v2-avatar" style="background:${strToColor(email.from_email)};width:28px;height:28px;font-size:11px;">
                    ${(email.from_name || email.from_email)[0].toUpperCase()}
                </div>
                <div>
                    <div class="sa-detail-from">${escHtml(email.from_name || email.from_email)} &lt;${escHtml(email.from_email)}&gt;</div>
                    <div class="sa-detail-date-full">${email.date}</div>
                </div>
            </div>
            <div class="sa-detail-actions">
                <button class="v2-btn v2-btn-sm sa-schedule-btn" onclick="saOpenPanel('${escAttr(email.from_email)}', '${escAttr(email.from_name)}')">
                    📅 Schedule
                </button>
                <button class="v2-btn v2-btn-sm v2-btn-secondary" onclick="saMarkUnread('${escAttr(email.id)}')">Mark Unread</button>
                <button class="v2-btn v2-btn-sm v2-btn-danger sa-delete-btn" onclick="saDeleteEmail('${escAttr(email.id)}')">Delete</button>
                ${saIntentBadgeHtml(intentInfo, checkingIntent)}
            </div>
            <div class="sa-detail-body">${escHtml(email.body || email.snippet)}</div>
        </div>
        <div class="sa-reply-bar">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <button class="v2-btn v2-btn-sm${saReplyMode === 'reply' ? ' v2-btn-secondary' : ' v2-btn-ghost'}" onclick="saSetReplyMode('reply')">Reply</button>
                <button class="v2-btn v2-btn-sm${saReplyMode === 'reply-all' ? ' v2-btn-secondary' : ' v2-btn-ghost'}" onclick="saSetReplyMode('reply-all')">Reply All</button>
                <span class="sa-reply-to" style="flex:1;font-size:12px;color:var(--text-muted);">
                    → ${saReplyMode === 'reply-all'
                        ? escHtml([email.from_email, ...(email.to_addresses || [])].join(', '))
                        : escHtml(email.from_name || email.from_email)}
                </span>
            </div>
            <textarea id="sa-reply-text" class="v2-textarea sa-reply-textarea" rows="3" placeholder="Write a reply…"></textarea>
            <div class="sa-reply-actions">
                <button class="v2-btn v2-btn-primary v2-btn-sm" onclick="saSendReply()">Send</button>
            </div>
        </div>`;
}

// ── Scheduling Assist Panel ─────────────────────────────────────
function saOpenPanel(contactEmail, contactName) {
    const panel = document.getElementById('sa-panel');
    const body = document.getElementById('sa-panel-body');
    panel.classList.add('open');
    saSelectedSlots.clear();
    saShowExpanded = false;

    body.innerHTML = '<div class="sa-panel-loading"><div class="v2-spinner"></div>Analyzing calendars…</div>';

    // Fetch my events + their freebusy in parallel
    Promise.all([
        fetch('/api/calendar-email/my-events?days=7').then(r => r.json()).catch(() => []),
        fetch(`/api/calendar-email/freebusy/${encodeURIComponent(contactEmail)}?days=7`).then(r => r.json()).catch(() => ({ busy: [], accessible: false }))
    ]).then(([myEvents, theirData]) => {
        saMyEvents = myEvents;
        const theirBusy = theirData.busy || [];
        const theirAccessible = theirData.accessible !== false;

        // Generate slots
        const slots = generateSlots(myEvents, theirBusy, theirAccessible, saMeetingDurationMins);
        const confidence = theirAccessible ? 'high' : 'medium';

        saRenderPanel(contactEmail, contactName, slots, confidence, theirAccessible, theirBusy);
    }).catch(err => {
        body.innerHTML = `<div class="sa-panel-notice" style="background:var(--danger-muted);color:var(--danger);">
            <span class="notice-icon">⚠</span>
            <span>Could not load calendar data: ${escHtml(err.message)}</span>
        </div>`;
    });
}

function saClosePanel() {
    document.getElementById('sa-panel').classList.remove('open');
}

function saRenderPanel(contactEmail, contactName, slots, confidence, theirAccessible, theirBusy) {
    const body = document.getElementById('sa-panel-body');

    // Confidence labels
    const confLabels = {
        high: 'High confidence — based on shared free/busy',
        medium: 'Medium — based on your calendar + working hours',
        low: 'Low — based on your availability only'
    };

    // Progressive disclosure: show top 4 suggestions first to keep the panel scannable.
    const visibleSlots = saShowExpanded ? slots : slots.slice(0, 4);
    const hasMore = slots.length > 4;
    const overlappingSlots = slots.filter(s => s.isOverlap);

    let overlapNotice = '';
    if (theirAccessible && overlappingSlots.length > 0) {
        overlapNotice = `<div class="sa-panel-notice" style="background:var(--success-muted);color:var(--success);margin-bottom:12px;border-radius:var(--radius-sm);padding:8px 12px;">
            <span class="notice-icon">✓</span>
            <span>Overlap found — ${overlappingSlots.length} mutual free slot${overlappingSlots.length > 1 ? 's' : ''} found</span>
        </div>`;
    }
    if (!theirAccessible) {
        overlapNotice = `<div class="sa-panel-notice" style="background:var(--surface-alt);color:var(--text-muted);margin-bottom:12px;border-radius:var(--radius-sm);padding:8px 12px;">
            <span class="notice-icon">🔒</span>
            <span>No calendar access — suggesting based on your availability</span>
        </div>`;
    }

    // Slot chips
    let slotsHtml = '';
    if (visibleSlots.length === 0) {
        slotsHtml = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No available slots found in the next 7 days.</div>';
    } else {
        slotsHtml = visibleSlots.map((s, i) => {
            const sel = saSelectedSlots.has(i) ? ' selected' : '';
            const overlap = s.isOverlap ? ' overlap' : '';
            return `<div class="sa-slot-chip${sel}${overlap}" onclick="saToggleSlot(${i})" data-slot-idx="${i}">
                <span class="sa-slot-day">${s.dayName}, ${s.dateLabel}</span>
                <span class="sa-slot-time">${s.startLabel} – ${s.endLabel}</span>
            </div>`;
        }).join('');
    }

    // Privacy-first availability view
    let privacyHtml = '';
    if (theirAccessible) {
        const showDetailed = saPrivacyDetailed;
        let blocksHtml = '';
        if (theirBusy && theirBusy.length > 0) {
            const limitedBusy = theirBusy.slice(0, 8);
            blocksHtml = limitedBusy.map(b => {
                const startStr = new Date(b.start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
                const endStr = new Date(b.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                return `<div class="sa-avail-block busy">
                    <span class="sa-avail-block-swatch"></span>
                    <span>${showDetailed ? 'Busy' : 'Busy'}: ${startStr} – ${endStr}</span>
                </div>`;
            }).join('');
        } else {
            blocksHtml = '<div style="color:var(--text-muted);font-size:12px;">No busy blocks found — calendar appears mostly free.</div>';
        }
        privacyHtml = `
            <div class="sa-panel-section">
                <div class="sa-panel-section-title">Their Availability (${showDetailed ? 'Detailed' : 'Free/Busy'})</div>
                <div class="sa-avail-blocks">${blocksHtml}</div>
            </div>`;
    }

    // Build reply preview
    const replyText = buildReplyText(contactName, visibleSlots);

    body.innerHTML = `
        ${overlapNotice}

        <div class="sa-confidence ${confidence}">
            <span class="sa-confidence-dot"></span>
            <span>${confLabels[confidence]}</span>
        </div>

        <div class="sa-panel-section">
            <div class="sa-panel-section-title">Suggested Times</div>
            <div class="sa-slots" id="sa-slots-container">
                ${slotsHtml}
            </div>
            ${hasMore && !saShowExpanded ? `<button class="v2-btn v2-btn-ghost v2-btn-sm sa-more-slots" onclick="saExpandSlots()">Show ${slots.length - 4} more options</button>` : ''}
        </div>

        ${privacyHtml}

        <div class="sa-panel-section">
            <div class="sa-panel-section-title">Options</div>
            <div class="sa-panel-toggles">
                <div class="sa-duration-picker" role="group" aria-label="Meeting duration">
                    <span class="sa-duration-label">Meeting length</span>
                    <div class="sa-duration-buttons">
                        <button class="v2-btn v2-btn-sm ${saMeetingDurationMins === 30 ? 'v2-btn-secondary' : 'v2-btn-ghost'}" onclick="saSetMeetingDuration(30)">30 min</button>
                        <button class="v2-btn v2-btn-sm ${saMeetingDurationMins === 60 ? 'v2-btn-secondary' : 'v2-btn-ghost'}" onclick="saSetMeetingDuration(60)">60 min</button>
                    </div>
                </div>
                ${theirAccessible ? `<label class="v2-toggle" onclick="saTogglePrivacy()">
                    <input type="checkbox" ${saPrivacyDetailed ? 'checked' : ''}>
                    <span class="v2-toggle-track"></span>
                    Show details (if permitted)
                </label>` : ''}
                <label class="v2-toggle" onclick="saToggleHolds()">
                    <input type="checkbox" ${saCreateHolds ? 'checked' : ''}>
                    <span class="v2-toggle-track"></span>
                    Create holds on my calendar
                </label>
            </div>
        </div>

        <hr class="v2-separator" style="margin: 16px 0;">

        <div class="sa-panel-section">
            <div class="sa-panel-section-title">Draft Reply</div>
            <div class="sa-reply-preview" id="sa-draft-reply">${escHtml(replyText)}</div>
            <button class="v2-btn v2-btn-primary" style="width:100%;" onclick="saInsertReply()">
                Insert Reply
            </button>
        </div>`;

    // Persist panel context so interaction handlers can re-render without refetching.
    body._slotsData = slots;
    body._contactEmail = contactEmail;
    body._contactName = contactName;
    body._confidence = confidence;
    body._theirAccessible = theirAccessible;
    body._theirBusy = theirBusy;
}

// ── Slot generation algorithm ───────────────────────────────────
function generateSlots(myEvents, theirBusy, theirAccessible, slotDuration = 30) {
    const WORK_START = 9 * 60;   // 9:00 AM
    const WORK_END = 18 * 60;    // 6:00 PM
    const SLOT_DURATION = slotDuration;
    const now = new Date();
    const slots = [];

    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const date = new Date(now);
        date.setDate(date.getDate() + dayOffset);

        // Skip weekends
        if (date.getDay() === 0 || date.getDay() === 6) continue;

        const dateStr = date.toISOString().split('T')[0];
        const dayStart = new Date(dateStr + 'T00:00:00');

        for (let mins = WORK_START; mins + SLOT_DURATION <= WORK_END; mins += SLOT_DURATION) {
            // For today, skip past times (at least 30 min from now)
            if (dayOffset === 0) {
                const currentMins = now.getHours() * 60 + now.getMinutes();
                if (mins < currentMins + 30) continue;
            }

            const slotStartDate = new Date(dayStart.getTime() + mins * 60000);
            const slotEndDate = new Date(dayStart.getTime() + (mins + SLOT_DURATION) * 60000);

            // Skip conflicts with your existing events.
            if (isMyTimeBusy(slotStartDate, slotEndDate, myEvents)) continue;

            // If free/busy is accessible, prefer mutual-free windows.
            let theirFree = true;
            if (theirAccessible && theirBusy.length > 0) {
                theirFree = !isTheirTimeBusy(slotStartDate, slotEndDate, theirBusy);
            }

            slots.push({
                date: dateStr,
                dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
                dateLabel: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                startMins: mins,
                endMins: mins + SLOT_DURATION,
                startLabel: minsToLabel(mins),
                endLabel: minsToLabel(mins + SLOT_DURATION),
                isOverlap: theirAccessible && theirFree,
            });
        }
    }

    // Rank mutual-free slots first, then keep chronological ordering.
    slots.sort((a, b) => {
        if (a.isOverlap !== b.isOverlap) return b.isOverlap ? 1 : -1;
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.startMins - b.startMins;
    });

    return slots;
}

function isMyTimeBusy(slotStart, slotEnd, myEvents) {
    if (!myEvents || !Array.isArray(myEvents)) return false;
    return myEvents.some(ev => {
        const evStart = new Date(ev.start);
        const evEnd = new Date(ev.end);
        return slotEnd > evStart && slotStart < evEnd;
    });
}

function isTheirTimeBusy(slotStart, slotEnd, busySlots) {
    return busySlots.some(b => {
        const bStart = new Date(b.start);
        const bEnd = new Date(b.end);
        return slotEnd > bStart && slotStart < bEnd;
    });
}

function minsToLabel(totalMins) {
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// ── Slot interaction ────────────────────────────────────────────
function saToggleSlot(idx) {
    if (saSelectedSlots.has(idx)) {
        saSelectedSlots.delete(idx);
    } else {
        saSelectedSlots.add(idx);
    }
    // Update only the parts affected by selection to keep interactions snappy.
    const body = document.getElementById('sa-panel-body');
    const slots = body._slotsData;
    if (!slots) return;

    // Update slot chip visual state
    document.querySelectorAll('.sa-slot-chip').forEach(chip => {
        const i = parseInt(chip.dataset.slotIdx);
        chip.classList.toggle('selected', saSelectedSlots.has(i));
    });

    // Update draft reply
    const selectedSlotList = [...saSelectedSlots].map(i => slots[i]).filter(Boolean);
    const replyText = buildReplyText(body._contactName, selectedSlotList.length > 0 ? selectedSlotList : slots.slice(0, 4));
    const preview = document.getElementById('sa-draft-reply');
    if (preview) preview.textContent = replyText;
}

function saExpandSlots() {
    saShowExpanded = true;
    const body = document.getElementById('sa-panel-body');
    if (body._slotsData) {
        saRenderPanel(body._contactEmail, body._contactName, body._slotsData, body._confidence || 'medium', body._theirAccessible, body._theirBusy);
    }
}

function saTogglePrivacy() {
    saPrivacyDetailed = !saPrivacyDetailed;
    const body = document.getElementById('sa-panel-body');
    if (body._slotsData) {
        saRenderPanel(body._contactEmail, body._contactName, body._slotsData, body._confidence || 'medium', body._theirAccessible, body._theirBusy);
    }
}

function saToggleHolds() {
    saCreateHolds = !saCreateHolds;
}

function saSetMeetingDuration(minutes) {
    const normalized = Number(minutes) === 60 ? 60 : 30;
    if (normalized === saMeetingDurationMins) return;
    saMeetingDurationMins = normalized;
    saSelectedSlots.clear();
    saShowExpanded = false;

    const body = document.getElementById('sa-panel-body');
    if (!body || !body._contactEmail) return;

    const slots = generateSlots(saMyEvents || [], body._theirBusy || [], body._theirAccessible !== false, saMeetingDurationMins);
    saRenderPanel(
        body._contactEmail,
        body._contactName,
        slots,
        body._confidence || 'medium',
        body._theirAccessible,
        body._theirBusy || []
    );
}

// ── Build reply text ────────────────────────────────────────────
function buildReplyText(name, slots) {
    if (!slots || slots.length === 0) {
        return `Hi ${name || 'there'},\n\nI'd like to schedule a meeting. When would you be available?\n\nBest`;
    }

    // If user selected specific chips, prioritize those over default suggestions.
    const selectedList = [...saSelectedSlots].map(i => {
        const body = document.getElementById('sa-panel-body');
        return body?._slotsData?.[i];
    }).filter(Boolean);

    const displaySlots = selectedList.length > 0 ? selectedList : slots.slice(0, 3);

    const slotLines = displaySlots.map(s =>
        `  • ${s.dayName}, ${s.dateLabel} at ${s.startLabel} – ${s.endLabel}`
    ).join('\n');

    return `Hi ${name || 'there'},\n\nWould any of these times work for a meeting?\n\n${slotLines}\n\nLet me know what works best!\n\nBest`;
}

// ── Insert reply into reply textarea ────────────────────────────
function saInsertReply() {
    const preview = document.getElementById('sa-draft-reply');
    const textarea = document.getElementById('sa-reply-text');
    if (preview && textarea) {
        textarea.value = preview.textContent;
        textarea.focus();
        // Scroll to reply textarea
        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ── Reply mode ───────────────────────────────────────────────────
function saSetReplyMode(mode) {
    saReplyMode = mode;
    if (saSelectedEmail) {
        const panel = document.getElementById('sa-detail');
        const intentInfo = saIntentByEmailId.get(saSelectedEmail.id) || null;
        panel.innerHTML = saBuildDetailHtml(saSelectedEmail, intentInfo, false);
    }
}

// ── Reply and actions ───────────────────────────────────────────
function saSendReply() {
    if (!saSelectedEmail) return;
    const text = document.getElementById('sa-reply-text')?.value?.trim();
    if (!text) return;

    const toAddresses = saReplyMode === 'reply-all'
        ? [saSelectedEmail.from_email, ...(saSelectedEmail.to_addresses || [])].join(', ')
        : saSelectedEmail.from_email;

    fetch('/api/calendar-email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            to: toAddresses,
            subject: 'Re: ' + saSelectedEmail.subject,
            body: text,
            threadId: saSelectedEmail.threadId,
        }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        document.getElementById('sa-reply-text').value = '';
        showToast('Reply sent!', 'success');
        saLoadInbox();
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

function saMarkUnread(messageId) {
    fetch('/api/email/mark-unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        const email = saAllEmails.find(e => e.id === messageId);
        if (email && !email.labels.includes('UNREAD')) email.labels.push('UNREAD');
        saSelectedEmail = null;
        saRenderInbox();
        document.getElementById('sa-detail').innerHTML = `
            <div class="sa-detail-placeholder"><div class="sa-placeholder-icon">✉</div><p>Select an email to read</p></div>`;
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

function saDeleteEmail(messageId) {
    if (!confirm('Move this email to trash?')) return;
    fetch('/api/email/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        saAllEmails = saAllEmails.filter(e => e.id !== messageId);
        saSelectedEmail = null;
        saRenderInbox();
        document.getElementById('sa-detail').innerHTML = `
            <div class="sa-detail-placeholder"><div class="sa-placeholder-icon">✉</div><p>Select an email to read</p></div>`;
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

// ── Composer ────────────────────────────────────────────────────
function saOpenComposer() {
    document.getElementById('sa-compose-modal').style.display = 'flex';
    document.getElementById('sa-compose-to').value = '';
    document.getElementById('sa-compose-subject').value = '';
    document.getElementById('sa-compose-body').value = '';
}

function saCloseComposer() {
    document.getElementById('sa-compose-modal').style.display = 'none';
}

function saSendCompose() {
    const to = document.getElementById('sa-compose-to').value.trim();
    const subject = document.getElementById('sa-compose-subject').value.trim();
    const body = document.getElementById('sa-compose-body').value.trim();
    if (!to || !subject || !body) { showToast('Please fill in all fields', 'error'); return; }

    fetch('/api/calendar-email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        saCloseComposer();
        showToast('Email sent!', 'success');
        saLoadInbox();
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

// ── Helpers ─────────────────────────────────────────────────────
function escHtml(str) {
    // Escape untrusted text before inserting into innerHTML.
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}
function escAttr(str) {
    // Minimal escaping for text interpolated inside HTML attributes.
    return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
function strToColor(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 50%, 45%)`;
}
function fmtDate(dateStr) {
    try {
        const d = new Date(dateStr);
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch { return dateStr || ''; }
}

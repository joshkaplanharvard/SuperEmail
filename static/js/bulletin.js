/**
 * Bulletin Board Email – Prototype A
 * Fetches Gmail threads and renders them as pinnable cards on a Kanban-style board.
 */

const CATEGORY_ORDER = [
    'Important', 'Action Items', 'Scheduling', 'Ideas',
    'Updates', 'Questions', 'General'
];

const CATEGORY_ICONS = {
    'Important':    '⭐',
    'Action Items': '✅',
    'Scheduling':   '📅',
    'Ideas':        '💡',
    'Updates':      '📢',
    'Questions':    '❓',
    'General':      '📌',
};

let allThreads = [];
let pinnedIds = new Set(JSON.parse(localStorage.getItem('bulletin_pinned') || '[]'));

// ── Load emails and render board ────────────────────────────────
function loadEmails() {
    const board = document.getElementById('board');
    board.innerHTML = `
        <div class="loading-overlay" id="loading">
            <div class="spinner"></div>
            <p>Loading your bulletin board…</p>
        </div>`;

    const q = document.getElementById('search-input').value.trim();
    const query = q ? encodeURIComponent(q) : encodeURIComponent('(is:unread OR is:starred) newer_than:7d');

    fetch(`/api/bulletin/emails?q=${query}&max=50`)
        .then(r => r.json())
        .then(threads => {
            if (threads.error) {
                board.innerHTML = `<div class="loading-overlay"><p>⚠️ ${threads.error}</p></div>`;
                return;
            }
            allThreads = threads;
            // Restore pinned state
            allThreads.forEach(t => { t.pinned = pinnedIds.has(t.threadId); });
            renderBoard();
        })
        .catch(err => {
            board.innerHTML = `<div class="loading-overlay"><p>Error loading emails: ${err.message}</p></div>`;
        });
}

function renderBoard() {
    const board = document.getElementById('board');
    board.innerHTML = '';

    // Sort: pinned first, then Action Items, then alphabetically by sender name
    const sorted = [...allThreads].sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
        const aAction = a.category === 'Action Items' ? 1 : 0;
        const bAction = b.category === 'Action Items' ? 1 : 0;
        if (aAction !== bAction) return bAction - aAction;
        const nameA = (a.participants[0]?.name || a.participants[0]?.email || '').toLowerCase();
        const nameB = (b.participants[0]?.name || b.participants[0]?.email || '').toLowerCase();
        return nameA.localeCompare(nameB);
    });

    sorted.forEach(thread => {
        board.appendChild(createCard(thread));
    });
}

function createCard(thread) {
    const card = document.createElement('div');
    card.className = `bulletin-card${thread.pinned ? ' pinned' : ''}${thread.isUnread ? ' unread' : ''}`;
    card.dataset.threadId = thread.threadId;

    const avatars = thread.participants.slice(0, 3).map(p => {
        const initial = (p.name || p.email)[0].toUpperCase();
        const color = stringToColor(p.email);
        return `<div class="avatar" style="background:${color}" title="${p.name || p.email}">${initial}</div>`;
    }).join('');

    const msgCount = thread.messages ? thread.messages.length : 1;

    const cat = thread.category || 'General';
    const catIcon = CATEGORY_ICONS[cat] || '📌';
    const catSlug = cat.toLowerCase().replace(/\s+/g, '-');
    const unreadDot = thread.isUnread ? '<span class="unread-dot" title="Unread"></span>' : '';

    card.innerHTML = `
        <button class="card-pin" onclick="event.stopPropagation(); togglePin('${thread.threadId}')" title="Pin/Unpin">
            ${thread.pinned ? '📌' : '○'}
        </button>
        ${unreadDot}
        <span class="card-category category-${catSlug}">${catIcon} ${cat}</span>
        <div class="card-subject">${escapeHtml(thread.subject)}</div>
        <div class="card-snippet">${escapeHtml(thread.snippet)}</div>
        <div class="card-footer">
            <div class="card-participants">${avatars}</div>
            <span class="card-msg-count">${msgCount} msg${msgCount > 1 ? 's' : ''}</span>
        </div>`;

    card.addEventListener('click', () => openCard(thread));
    return card;
}

// ── Pin / unpin ────────────────────────────────────────────────
function togglePin(threadId) {
    if (pinnedIds.has(threadId)) {
        pinnedIds.delete(threadId);
    } else {
        pinnedIds.add(threadId);
    }
    localStorage.setItem('bulletin_pinned', JSON.stringify([...pinnedIds]));
    allThreads.forEach(t => { t.pinned = pinnedIds.has(t.threadId); });
    renderBoard();
}

// ── Open card detail ───────────────────────────────────────────
let currentThread = null;
let replyMode = 'reply'; // 'reply' or 'reply-all'

function setReplyMode(mode) {
    replyMode = mode;
    document.getElementById('btn-reply').classList.toggle('active', mode === 'reply');
    document.getElementById('btn-reply-all').classList.toggle('active', mode === 'reply-all');
    updateReplyRecipients();
}

function updateReplyRecipients() {
    if (!currentThread) return;
    const container = document.getElementById('modal-reply-recipients');
    if (!container) return;

    let recipients;
    if (replyMode === 'reply') {
        // Reply to the last message sender
        const lastMsg = currentThread.messages?.[currentThread.messages.length - 1];
        const sender = lastMsg ? (lastMsg.from_name || lastMsg.from_email) : (currentThread.participants[0]?.name || currentThread.participants[0]?.email);
        const senderEmail = lastMsg ? lastMsg.from_email : currentThread.participants[0]?.email;
        recipients = `To: ${sender} &lt;${escapeHtml(senderEmail)}&gt;`;
    } else {
        // Reply all: all participants
        recipients = 'To: ' + currentThread.participants
            .map(p => `${escapeHtml(p.name || p.email)} &lt;${escapeHtml(p.email)}&gt;`)
            .join(', ');
    }
    container.innerHTML = recipients;
}

function openCard(thread) {
    currentThread = thread;
    document.getElementById('modal-subject').textContent = thread.subject;
    document.getElementById('modal-meta').textContent =
        `${thread.participants.map(p => p.name || p.email).join(', ')} • ${thread.messages?.length || 1} messages`;

    const body = document.getElementById('modal-body');
    body.innerHTML = '<div class="spinner"></div>';

    // Mark as read in Gmail and locally
    if (thread.isUnread) {
        fetch('/api/email/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: thread.threadId }),
        }).catch(() => {});
        thread.isUnread = false;
        renderBoard();
    }

    // Fetch full thread
    fetch(`/api/bulletin/thread/${thread.threadId}`)
        .then(r => r.json())
        .then(messages => {
            body.innerHTML = messages.map(msg => `
                <div class="thread-message">
                    <div class="thread-message-header">
                        <div class="avatar" style="background:${stringToColor(msg.from_email)};width:24px;height:24px;font-size:10px;">
                            ${(msg.from_name || msg.from_email)[0].toUpperCase()}
                        </div>
                        <span class="thread-message-sender">${escapeHtml(msg.from_name || msg.from_email)}</span>
                        <span class="thread-message-date">${formatDate(msg.date)}</span>
                    </div>
                    <div class="thread-message-body">${escapeHtml(msg.body || msg.snippet)}</div>
                </div>
            `).join('');
        })
        .catch(err => {
            body.innerHTML = `<p>Error loading thread: ${err.message}</p>`;
        });

    document.getElementById('card-modal').style.display = 'flex';
    document.getElementById('modal-reply-text').value = '';
    replyMode = 'reply';
    document.getElementById('btn-reply').classList.add('active');
    document.getElementById('btn-reply-all').classList.remove('active');
    updateReplyRecipients();
}

function closeModal() {
    document.getElementById('card-modal').style.display = 'none';
    currentThread = null;
}

function markThreadUnread() {
    if (!currentThread) return;
    fetch('/api/email/mark-unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: currentThread.threadId }),
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) { alert('Error: ' + data.error); return; }
            currentThread.isUnread = true;
            closeModal();
            renderBoard();
        })
        .catch(err => alert('Error: ' + err.message));
}

function deleteThread() {
    if (!currentThread) return;
    if (!confirm('Move this conversation to trash?')) return;
    fetch('/api/email/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: currentThread.threadId }),
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) { alert('Error: ' + data.error); return; }
            allThreads = allThreads.filter(t => t.threadId !== currentThread.threadId);
            closeModal();
            renderBoard();
        })
        .catch(err => alert('Error: ' + err.message));
}

function sendReply() {
    if (!currentThread) return;
    const text = document.getElementById('modal-reply-text').value.trim();
    if (!text) return;

    let to;
    if (replyMode === 'reply') {
        // Reply to last message sender only
        const lastMsg = currentThread.messages?.[currentThread.messages.length - 1];
        to = lastMsg ? lastMsg.from_email : currentThread.participants[0]?.email;
    } else {
        // Reply all
        to = currentThread.participants
            .map(p => p.email)
            .filter(e => e)
            .join(', ');
    }

    fetch('/api/bulletin/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            to: to,
            subject: 'Re: ' + currentThread.subject,
            body: text,
            threadId: currentThread.threadId,
        }),
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                alert('Error sending: ' + data.error);
            } else {
                document.getElementById('modal-reply-text').value = '';
                alert('Reply sent!');
                closeModal();
                loadEmails();
            }
        })
        .catch(err => alert('Send error: ' + err.message));
}

// ── Compose new note ───────────────────────────────────────────
function openComposer() {
    document.getElementById('compose-modal').style.display = 'flex';
    document.getElementById('compose-to').value = '';
    document.getElementById('compose-subject').value = '';
    document.getElementById('compose-body').value = '';
}

function closeComposer() {
    document.getElementById('compose-modal').style.display = 'none';
}

function sendNote() {
    const to = document.getElementById('compose-to').value.trim();
    const subject = document.getElementById('compose-subject').value.trim();
    const body = document.getElementById('compose-body').value.trim();

    if (!to || !subject || !body) {
        alert('Please fill in all fields');
        return;
    }

    fetch('/api/bulletin/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body }),
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                alert('Error: ' + data.error);
            } else {
                closeComposer();
                alert('Email sent!');
                loadEmails();
            }
        })
        .catch(err => alert('Error: ' + err.message));
}

// ── Helpers ────────────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 50%)`;
}

function formatDate(dateStr) {
    try {
        const d = new Date(dateStr);
        const now = new Date();
        if (d.toDateString() === now.toDateString()) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
        return dateStr || '';
    }
}

// ── Search handling ────────────────────────────────────────────
document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadEmails();
});

// Close modals on overlay click
document.getElementById('card-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('card-modal')) closeModal();
});
document.getElementById('compose-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('compose-modal')) closeComposer();
});

// ── Boot ───────────────────────────────────────────────────────
loadEmails();

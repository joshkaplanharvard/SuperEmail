/**
 * Calendar-Integrated Email – Prototype B
 * Gmail inbox with inline calendar availability when clicking a sender.
 */

let allEmails = [];
let selectedEmail = null;
let calendarCache = {};  // email -> availability data

// ── Load inbox ─────────────────────────────────────────────────
function loadInbox() {
    const list = document.getElementById('inbox-list');
    list.innerHTML = `
        <div class="loading-overlay" id="loading">
            <div class="spinner"></div>
            <p>Loading inbox…</p>
        </div>`;

    const q = document.getElementById('search-input').value.trim();
    const query = q ? encodeURIComponent(q) : 'in%3Ainbox';

    fetch(`/api/calendar-email/emails?q=${query}&max=40`)
        .then(r => r.json())
        .then(emails => {
            if (emails.error) {
                list.innerHTML = `<div class="loading-overlay"><p>⚠️ ${emails.error}</p></div>`;
                return;
            }
            allEmails = emails;
            renderInbox();
        })
        .catch(err => {
            list.innerHTML = `<div class="loading-overlay"><p>Error: ${err.message}</p></div>`;
        });
}

function renderInbox() {
    const list = document.getElementById('inbox-list');
    list.innerHTML = '';

    allEmails.forEach(email => {
        const row = document.createElement('div');
        const isUnread = (email.labels || []).includes('UNREAD');
        row.className = 'email-row' + (selectedEmail?.id === email.id ? ' selected' : '') + (isUnread ? ' unread' : '');

        const initial = (email.from_name || email.from_email || '?')[0].toUpperCase();
        const color = stringToColor(email.from_email);
        const unreadDot = isUnread ? '<span class="unread-dot" title="Unread"></span>' : '';

        row.innerHTML = `
            <div class="avatar" style="background:${color}" 
                 onclick="event.stopPropagation(); showCalendar('${escapeAttr(email.from_email)}', '${escapeAttr(email.from_name)}')"
                 title="Click to view ${email.from_name || email.from_email}'s calendar">
                ${initial}
            </div>
            <div class="email-info">
                <div class="email-sender" 
                     onclick="event.stopPropagation(); showCalendar('${escapeAttr(email.from_email)}', '${escapeAttr(email.from_name)}')">
                    ${unreadDot}${escapeHtml(email.from_name || email.from_email)}
                </div>
                <div class="email-subject">${escapeHtml(email.subject)}</div>
                <div class="email-snippet">${escapeHtml(email.snippet)}</div>
            </div>
            <div class="email-date">${formatDate(email.date)}</div>`;

        row.addEventListener('click', () => showEmailDetail(email));
        list.appendChild(row);
    });
}

// ── Show email detail (right panel) ────────────────────────────
function showEmailDetail(email) {
    selectedEmail = email;

    // Mark as read in Gmail and locally
    if ((email.labels || []).includes('UNREAD')) {
        fetch('/api/email/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: email.id }),
        }).catch(() => {});
        email.labels = email.labels.filter(l => l !== 'UNREAD');
    }

    renderInbox(); // Update selected state

    const panel = document.getElementById('context-panel');
    panel.innerHTML = `
        <div class="email-detail">
            <div class="email-detail-header">
                <div class="email-detail-subject">${escapeHtml(email.subject)}</div>
                <div class="email-detail-meta">
                    <div class="avatar" style="background:${stringToColor(email.from_email)};width:32px;height:32px;font-size:13px;"
                         onclick="showCalendar('${escapeAttr(email.from_email)}', '${escapeAttr(email.from_name)}')"
                         title="View calendar">
                        ${(email.from_name || email.from_email)[0].toUpperCase()}
                    </div>
                    <span class="email-detail-from" 
                          onclick="showCalendar('${escapeAttr(email.from_email)}', '${escapeAttr(email.from_name)}')">
                        ${escapeHtml(email.from_name || email.from_email)}
                    </span>
                    <a class="view-availability-link" href="javascript:void(0)"
                       onclick="showCalendar('${escapeAttr(email.from_email)}', '${escapeAttr(email.from_name)}')">
                        📅 View availability
                    </a>
                    <span class="email-detail-date">${email.date}</span>
                </div>
                <div class="email-detail-actions">
                    <button class="btn btn-icon" onclick="markEmailUnread('${escapeAttr(email.id)}')" title="Mark as unread">✉ Unread</button>
                    <button class="btn btn-icon btn-danger" onclick="deleteEmail('${escapeAttr(email.id)}')" title="Delete">🗑 Delete</button>
                </div>
            </div>
            <div class="email-detail-body">${escapeHtml(email.body || email.snippet)}</div>
            
            <div class="reply-bar">
                <div class="reply-recipients">
                    <span class="reply-to-label">To: ${escapeHtml(email.from_name || email.from_email)} &lt;${escapeHtml(email.from_email)}&gt;</span>
                    ${email.cc ? `<span class="reply-cc-label">Cc: ${escapeHtml(email.cc)}</span>` : ''}
                </div>
                <div class="reply-mode-toggle">
                    <button class="btn btn-icon reply-mode-btn active" id="cal-btn-reply" onclick="setCalReplyMode('reply')">↩ Reply</button>
                    <button class="btn btn-icon reply-mode-btn" id="cal-btn-reply-all" onclick="setCalReplyMode('reply-all')">↩↩ Reply All</button>
                </div>
                <textarea placeholder="Write a reply…" id="reply-text"></textarea>
                <button class="btn btn-primary" onclick="sendCalReply()">Send</button>
            </div>

            <div id="calendar-container"></div>
        </div>`;

    // Auto-load calendar for sender (collapsed by default)
    showCalendar(email.from_email, email.from_name, true);
}

// ── Show calendar availability ─────────────────────────────────
function showCalendar(email, name, startCollapsed) {
    // If we have cached data, render immediately
    if (calendarCache[email]) {
        const cached = calendarCache[email];
        if (cached.accessible === false) {
            // Re-render the unavailable message
            let container = document.getElementById('calendar-container');
            if (container) {
                container.innerHTML = `
                    <div class="calendar-panel">
                        <div class="calendar-panel-header">
                            <h3>📅 ${escapeHtml(name || email)}</h3>
                            <div class="calendar-header-btns">
                                <button class="calendar-panel-toggle" onclick="toggleCalendarPanel(this)">▼</button>
                                <button class="calendar-panel-close" onclick="document.getElementById('calendar-container').innerHTML=''">✕</button>
                            </div>
                        </div>
                        <div class="calendar-panel-body">
                            <div class="calendar-unavailable">
                                <span class="unavailable-icon">🔒</span>
                                <p><strong>${escapeHtml(name || email)}</strong>'s calendar is not shared with you.</p>
                                <p style="font-size:13px;color:var(--text-muted);margin-top:8px;">Their calendar may be private, or they may not use Google Calendar.</p>
                            </div>
                        </div>
                    </div>`;
                if (startCollapsed) {
                    container.querySelector('.calendar-panel-body').style.display = 'none';
                    container.querySelector('.calendar-panel-toggle').textContent = '▶';
                }
            }
            return;
        }
        renderCalendar(email, name, cached.days || cached, startCollapsed);
        return;
    }

    // Show loading in calendar container (or create one)
    let container = document.getElementById('calendar-container');
    if (!container) {
        // If no email is selected, create a standalone view
        const panel = document.getElementById('context-panel');
        panel.innerHTML = `
            <div class="email-detail">
                <div class="email-detail-header">
                    <div class="email-detail-subject">📅 Calendar: ${escapeHtml(name || email)}</div>
                </div>
                <div id="calendar-container"></div>
            </div>`;
        container = document.getElementById('calendar-container');
    }

    container.innerHTML = `
        <div class="calendar-panel">
            <div class="calendar-panel-header">
                <h3>📅 ${escapeHtml(name || email)}'s Availability</h3>
            </div>
            <div class="calendar-panel-body">
                <div class="loading-overlay"><div class="spinner"></div><p>Checking availability…</p></div>
            </div>
        </div>`;

    fetch(`/api/calendar-email/availability/${encodeURIComponent(email)}?days=7`)
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                container.innerHTML = `
                    <div class="calendar-panel">
                        <div class="calendar-panel-header">
                            <h3>📅 ${escapeHtml(name || email)}</h3>
                            <div class="calendar-header-btns">
                                <button class="calendar-panel-toggle" onclick="toggleCalendarPanel(this)">▼</button>
                                <button class="calendar-panel-close" onclick="document.getElementById('calendar-container').innerHTML=''">✕</button>
                            </div>
                        </div>
                        <div class="calendar-panel-body">
                            <p>⚠️ Could not retrieve calendar: ${escapeHtml(data.error)}</p>
                            <p style="font-size:13px;color:var(--text-muted);margin-top:8px;">
                                The contact may not have shared their calendar with you, or they may not use Google Calendar.
                            </p>
                        </div>
                    </div>`;
                return;
            }
            // Check if calendar is accessible
            if (data.accessible === false) {
                container.innerHTML = `
                    <div class="calendar-panel">
                        <div class="calendar-panel-header">
                            <h3>📅 ${escapeHtml(name || email)}</h3>
                            <div class="calendar-header-btns">
                                <button class="calendar-panel-toggle" onclick="toggleCalendarPanel(this)">▼</button>
                                <button class="calendar-panel-close" onclick="document.getElementById('calendar-container').innerHTML=''">✕</button>
                            </div>
                        </div>
                        <div class="calendar-panel-body">
                            <div class="calendar-unavailable">
                                <span class="unavailable-icon">🔒</span>
                                <p><strong>${escapeHtml(name || email)}</strong>'s calendar is not shared with you.</p>
                                <p style="font-size:13px;color:var(--text-muted);margin-top:8px;">Their calendar may be private, or they may not use Google Calendar.</p>
                            </div>
                        </div>
                    </div>`;
                return;
            }
            calendarCache[email] = data;
            renderCalendar(email, name, data.days || data, startCollapsed);
        })
        .catch(err => {
            container.innerHTML = `<p>Error loading calendar: ${err.message}</p>`;
        });
}

function toggleCalendarPanel(btn) {
    const panel = btn.closest('.calendar-panel');
    const body = panel.querySelector('.calendar-panel-body');
    if (body.style.display === 'none') {
        body.style.display = '';
        btn.textContent = '▼';
    } else {
        body.style.display = 'none';
        btn.textContent = '▶';
    }
}

function renderCalendar(email, name, days, startCollapsed) {
    const container = document.getElementById('calendar-container');
    if (!container) return;

    // Vertical Google Calendar-style layout
    const HOURS = Array.from({length: 24}, (_, i) => i); // 0..23

    let daysHtml = days.map((day, dayIdx) => {
        // Build 1-hour rows, marking busy ranges
        let rowsHtml = HOURS.map(h => {
            const startMins = h * 60;
            const endMins = startMins + 60;
            let isBusy = false;
            let busyLabel = '';
            day.busy.forEach(slot => {
                const sM = slot.start_mins != null ? slot.start_mins : parseTimeToMinutes(slot.start);
                const eM = slot.end_mins != null ? slot.end_mins : parseTimeToMinutes(slot.end);
                if (endMins > sM && startMins < eM) {
                    isBusy = true;
                    busyLabel = `${slot.start} – ${slot.end}`;
                }
            });
            const hour12 = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
            return `<div class="gcal-row ${isBusy ? 'busy' : 'free'}">
                <span class="gcal-hour">${hour12}</span>
                <div class="gcal-cell ${isBusy ? 'busy' : 'free'}">${isBusy ? escapeHtml(busyLabel) : ''}</div>
            </div>`;
        }).join('');

        return `
            <div class="gcal-day ${day.is_today ? 'is-today' : ''}">
                <div class="gcal-day-header">
                    <span class="gcal-day-name">${day.day_name}${day.is_today ? ' (Today)' : ''}</span>
                    <span class="gcal-day-date">${day.date}</span>
                </div>
                <div class="gcal-day-grid">
                    ${rowsHtml}
                </div>
            </div>`;
    }).join('');

    container.innerHTML = `
        <div class="calendar-panel">
            <div class="calendar-panel-header">
                <h3>📅 ${escapeHtml(name || email)}'s Availability (7 days)</h3>
                <div class="calendar-header-btns">
                    <button class="calendar-panel-toggle" onclick="toggleCalendarPanel(this)">${startCollapsed ? '▶' : '▼'}</button>
                    <button class="calendar-panel-close" onclick="document.getElementById('calendar-container').innerHTML=''">✕</button>
                </div>
            </div>
            <div class="calendar-panel-body" ${startCollapsed ? 'style="display:none"' : ''}>
                <div class="gcal-week">
                    ${daysHtml}
                </div>
                <div class="calendar-legend">
                    <div class="legend-item"><div class="legend-swatch free"></div> Free</div>
                    <div class="legend-item"><div class="legend-swatch busy"></div> Busy</div>
                </div>
                <button class="suggest-time-inline" onclick="suggestTime('${escapeAttr(email)}', '${escapeAttr(name)}')">
                    📅 Suggest a Meeting Time
                </button>
            </div>
        </div>`;
}

function parseTimeToMinutes(timeStr) {
    // Parse "09:00 AM" or "02:30 PM" to total minutes from midnight
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return 0;
    let h = parseInt(match[1]);
    const m = parseInt(match[2]);
    const ampm = match[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 60 + m;
}

// ── Suggest a time ─────────────────────────────────────────────
function suggestTime(email, name) {
    const cached = calendarCache[email];
    const data = cached ? (cached.days || cached) : null;
    if (!data) {
        openComposerWith(email, 'Meeting Request', '');
        return;
    }

    // Find the very next available 30-min slot (including today's remaining hours)
    const SLOT_MINS = 30;
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    let suggestion = '';

    for (const day of data) {
        // For today, start from the next half-hour; for future days, start from 8 AM
        let startSlot = day.is_today ? Math.ceil(currentMins / SLOT_MINS) : (8 * 60 / SLOT_MINS);
        const endSlot = 18 * 60 / SLOT_MINS; // Only suggest up to 6 PM

        for (let i = startSlot; i < endSlot; i++) {
            const slotStart = i * SLOT_MINS;
            const slotEnd = slotStart + SLOT_MINS;
            let isBusy = false;
            day.busy.forEach(slot => {
                const sM = slot.start_mins != null ? slot.start_mins : parseTimeToMinutes(slot.start);
                const eM = slot.end_mins != null ? slot.end_mins : parseTimeToMinutes(slot.end);
                if (slotEnd > sM && slotStart < eM) isBusy = true;
            });
            if (!isBusy) {
                const h = Math.floor(slotStart / 60);
                const m = slotStart % 60;
                const hour12 = h === 0 ? '12' : h > 12 ? `${h - 12}` : h === 12 ? '12' : `${h}`;
                const ampm = h >= 12 ? 'PM' : 'AM';
                const timeStr = `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
                suggestion = `Hi ${name || 'there'},\n\nAre you free on ${day.day_name} (${day.date}) at ${timeStr}? I'd love to set up a quick meeting.\n\nBest`;
                break;
            }
        }
        if (suggestion) break;
    }

    if (!suggestion) {
        suggestion = `Hi ${name || 'there'},\n\nI'd like to schedule a meeting. When would you be available?\n\nBest`;
    }

    openComposerWith(email, 'Meeting Request', suggestion);
}

// ── Compose / send ─────────────────────────────────────────────
function openComposer() {
    document.getElementById('compose-modal').style.display = 'flex';
    document.getElementById('compose-to').value = '';
    document.getElementById('compose-subject').value = '';
    document.getElementById('compose-body').value = '';

    // Show suggest button if we have a selected email
    const suggestBtn = document.getElementById('suggest-time-btn');
    if (selectedEmail) {
        suggestBtn.style.display = 'inline-flex';
        suggestBtn.dataset.email = selectedEmail.from_email;
        suggestBtn.dataset.name = selectedEmail.from_name;
    } else {
        suggestBtn.style.display = 'none';
    }
}

function openComposerWith(to, subject, body) {
    document.getElementById('compose-modal').style.display = 'flex';
    document.getElementById('compose-to').value = to;
    document.getElementById('compose-subject').value = subject;
    document.getElementById('compose-body').value = body;
}

function closeComposer() {
    document.getElementById('compose-modal').style.display = 'none';
    document.getElementById('compose-calendar-btn').style.display = 'none';
}

function onComposeToInput() {
    const to = document.getElementById('compose-to').value.trim();
    const btn = document.getElementById('compose-calendar-btn');
    // Show button when input looks like an email
    btn.style.display = (to.includes('@') && to.includes('.')) ? 'block' : 'none';
}

function viewComposeCalendar() {
    const to = document.getElementById('compose-to').value.trim();
    if (!to) return;
    closeComposer();
    showCalendar(to, to);
}

function insertTimeSuggestion() {
    const btn = document.getElementById('suggest-time-btn');
    const email = btn.dataset.email;
    const name = btn.dataset.name;
    suggestTime(email, name);
}

function sendEmail() {
    const to = document.getElementById('compose-to').value.trim();
    const subject = document.getElementById('compose-subject').value.trim();
    const body = document.getElementById('compose-body').value.trim();

    if (!to || !subject || !body) {
        alert('Please fill in all fields');
        return;
    }

    fetch('/api/calendar-email/send', {
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
                loadInbox();
            }
        })
        .catch(err => alert('Error: ' + err.message));
}

// ── Reply mode for calendar-email prototype ───────────────────
let calReplyMode = 'reply';

function setCalReplyMode(mode) {
    calReplyMode = mode;
    const btnReply = document.getElementById('cal-btn-reply');
    const btnAll = document.getElementById('cal-btn-reply-all');
    if (btnReply) btnReply.classList.toggle('active', mode === 'reply');
    if (btnAll) btnAll.classList.toggle('active', mode === 'reply-all');
    updateCalReplyRecipients();
}

function updateCalReplyRecipients() {
    if (!selectedEmail) return;
    const el = document.querySelector('.reply-recipients');
    if (!el) return;

    const email = selectedEmail;
    if (calReplyMode === 'reply') {
        el.innerHTML = `<span class="reply-to-label">To: ${escapeHtml(email.from_name || email.from_email)} &lt;${escapeHtml(email.from_email)}&gt;</span>`;
    } else {
        let parts = `<span class="reply-to-label">To: ${escapeHtml(email.from_name || email.from_email)} &lt;${escapeHtml(email.from_email)}&gt;`;
        if (email.to) parts += `, ${escapeHtml(email.to)}`;
        parts += `</span>`;
        if (email.cc) parts += `<span class="reply-cc-label">Cc: ${escapeHtml(email.cc)}</span>`;
        el.innerHTML = parts;
    }
}

function sendCalReply() {
    if (!selectedEmail) return;
    const text = document.getElementById('reply-text')?.value?.trim();
    if (!text) return;

    const email = selectedEmail;
    let to;
    if (calReplyMode === 'reply') {
        to = email.from_email;
    } else {
        // Reply all: from + to + cc
        const addrs = new Set();
        if (email.from_email) addrs.add(email.from_email);
        if (email.to) email.to.split(',').map(s => s.trim()).filter(Boolean).forEach(a => addrs.add(a));
        if (email.cc) email.cc.split(',').map(s => s.trim()).filter(Boolean).forEach(a => addrs.add(a));
        to = [...addrs].join(', ');
    }

    fetch('/api/calendar-email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            to: to,
            subject: 'Re: ' + email.subject,
            body: text,
            threadId: email.threadId,
        }),
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                alert('Error: ' + data.error);
            } else {
                document.getElementById('reply-text').value = '';
                alert('Reply sent!');
                loadInbox();
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

function escapeAttr(str) {
    return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return `hsl(${Math.abs(hash) % 360}, 55%, 50%)`;
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

// ── Search ─────────────────────────────────────────────────────
document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadInbox();
});

// Close compose modal on overlay click
document.getElementById('compose-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('compose-modal')) closeComposer();
});

// ── Mark unread / Delete (calendar email) ──────────────────────
function markEmailUnread(messageId) {
    fetch('/api/email/mark-unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) { alert('Error: ' + data.error); return; }
            // Update local state
            const email = allEmails.find(e => e.id === messageId);
            if (email && !email.labels.includes('UNREAD')) {
                email.labels.push('UNREAD');
            }
            selectedEmail = null;
            renderInbox();
            document.getElementById('context-panel').innerHTML = `
                <div class="context-placeholder">
                    <div class="placeholder-icon">📬</div>
                    <p>Select an email to view details</p>
                </div>`;
        })
        .catch(err => alert('Error: ' + err.message));
}

function deleteEmail(messageId) {
    if (!confirm('Move this email to trash?')) return;
    fetch('/api/email/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) { alert('Error: ' + data.error); return; }
            allEmails = allEmails.filter(e => e.id !== messageId);
            selectedEmail = null;
            renderInbox();
            document.getElementById('context-panel').innerHTML = `
                <div class="context-placeholder">
                    <div class="placeholder-icon">📬</div>
                    <p>Select an email to view details</p>
                </div>`;
        })
        .catch(err => alert('Error: ' + err.message));
}

// ── Boot ───────────────────────────────────────────────────────
loadInbox();

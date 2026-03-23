let ahMode = 'chat';
let ahHistory = [];

function ahSetMode(mode) {
    ahMode = mode;
    document.querySelectorAll('.ah-mode').forEach(btn => {
        const isActive = btn.dataset.mode === mode;
        btn.classList.toggle('active', isActive);
        btn.classList.toggle('v2-btn-secondary', isActive);
        btn.classList.toggle('v2-btn-ghost', !isActive);
    });
    ahSetStatus(mode === 'email' ? 'Email drafting mode' : 'Chat mode');
}

function ahClearChat() {
    ahHistory = [];
    document.getElementById('ah-chat').innerHTML = '';
    ahSetStatus('Cleared');
}

function ahSetStatus(text, isError = false) {
    const el = document.getElementById('ah-status');
    el.textContent = text;
    el.classList.toggle('error', isError);
}

function ahAddBubble(role, text, meta = '') {
    const chat = document.getElementById('ah-chat');
    const row = document.createElement('div');
    row.className = `ah-bubble-row ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'ah-bubble';

    const roleTag = document.createElement('div');
    roleTag.className = 'ah-role';
    roleTag.textContent = role === 'assistant' ? 'Assistant' : 'You';

    const content = document.createElement('div');
    content.className = 'ah-content';
    content.textContent = text;

    bubble.appendChild(roleTag);
    bubble.appendChild(content);

    if (meta) {
        const metaEl = document.createElement('div');
        metaEl.className = 'ah-meta';
        metaEl.textContent = meta;
        bubble.appendChild(metaEl);
    }

    row.appendChild(bubble);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
}

function ahSend() {
    const input = document.getElementById('ah-input');
    const message = (input.value || '').trim();
    if (!message) return;

    input.value = '';
    ahAddBubble('user', message);
    ahSetStatus('Sending request...');

    fetch('/api/ai-helper/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mode: ahMode,
            message,
            history: ahHistory,
        }),
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                ahSetStatus(`Error: ${data.error}`, true);
                ahAddBubble('assistant', `Error: ${data.error}`);
                return;
            }

            const reply = data.reply || '(empty response)';
            ahAddBubble('assistant', reply, `${data.model || 'unknown model'} | ${data.mode || ahMode}`);

            ahHistory.push({ role: 'user', content: message });
            ahHistory.push({ role: 'assistant', content: reply });
            if (ahHistory.length > 20) {
                ahHistory = ahHistory.slice(-20);
            }

            ahSetStatus('Response received');
        })
        .catch(err => {
            ahSetStatus(`Request failed: ${err.message}`, true);
            ahAddBubble('assistant', `Request failed: ${err.message}`);
        });
}

document.getElementById('ah-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ahSend();
    }
});

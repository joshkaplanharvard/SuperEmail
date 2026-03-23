# CSO: Parallel Prototyping – Email/CMC UI

Two alternative email interfaces built on top of **your real Gmail account**, designed for CS178 CSO (Critical Screening Objective) parallel prototyping.

## Prototype A: 📌 Bulletin Board Email
Instead of traditional chronological email threads, messages become **pinnable cards** on a spatial Kanban-style board. Cards are auto-categorised (Scheduling, Action Items, Ideas, Updates, Questions, etc.) so important ideas never get lost.

**Key features:**
- Emails auto-categorised into columns by subject keywords
- Pin important threads to keep them at the top
- Expand a card to see the full thread and reply inline
- Compose "notes" that send as real emails

## Prototype B: 📅 Calendar-Integrated Email
A familiar inbox view, but **clicking any sender's name/avatar** instantly shows their Google Calendar availability for the next 7 days — no more "when are you free?" back-and-forth.

**Key features:**
- 7-day availability heatmap (free/busy by hour, 9am–5pm)
- One-click "Suggest a Meeting Time" that auto-drafts an email with the first available slot
- Reply inline with calendar context visible
- Reduces scheduling friction on both sides

---

## Setup

### 1. Google Cloud Credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable **Gmail API** and **Google Calendar API**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Desktop app**
   - Download the JSON file
5. Rename it to `credentials.json` and place it in this project folder

### 2. Install Dependencies
```bash
cd "CSO:Parralel Prototyping Project (Email:CMC UI)"
pip install -r requirements.txt
```

### 3. Run
```bash
python app.py
```
On first run, a browser window will open asking you to sign in with your Gmail account and grant permissions. After that, the token is cached in `token.json`.

Open **http://127.0.0.1:5001** to see the landing page and choose a prototype.

### Optional: Harvard OpenAI urgency scoring for Triage Board
To enable AI-assisted urgency scoring in `/triage-board`, set these environment variables before starting Flask:

```bash
export HARVARD_OPENAI_API_KEY="your-harvard-api-key"
export HARVARD_OPENAI_BASE_URL="https://go.apis.huit.harvard.edu/ais-openai-direct-limited-schools/v1"
export HARVARD_OPENAI_MODEL="gpt-4o-mini"
```

The app also auto-loads a local `.env` file in the project root at startup,
so you can put these values in `.env` and run `python app.py` directly.

Notes:
- The API key is sent server-side only (never exposed in browser JavaScript).
- If the key is not configured (or the API call fails), the app automatically falls back to heuristic scoring.

---

## Project Structure
```
├── app.py                  # Flask server with routes for all prototypes
├── gmail_client.py         # Gmail API: OAuth, fetch, send emails
├── calendar_client.py      # Calendar API: free/busy, availability
├── config.py               # OAuth scopes, paths, secret key
├── requirements.txt
├── credentials.json        # ← YOU ADD THIS (from Google Cloud)
├── token.json              # Auto-generated after first OAuth login
├── static/
│   ├── css/
│   │   ├── common.css      # Shared styles (v1 prototypes)
│   │   ├── bulletin.css    # Bulletin board styles (v1)
│   │   ├── calendar.css    # Calendar email styles (v1)
│   │   ├── v2-common.css   # Shared dark theme (v2 prototypes)
│   │   ├── scheduling-assist.css  # Scheduling Assist styles (v2)
│   │   └── triage-board.css       # Triage Board styles (v2)
│   └── js/
│       ├── bulletin.js     # Bulletin board interactions (v1)
│       ├── calendar.js     # Calendar email interactions (v1)
│       ├── scheduling-assist.js   # Scheduling Assist logic (v2)
│       └── triage-board.js        # Triage Board logic (v2)
└── templates/
    ├── base.html           # Shared layout with nav (v1, light theme)
    ├── base_v2.html        # Shared layout with nav (v2, dark theme)
    ├── landing.html        # Prototype chooser (links to all variants)
    ├── bulletin/
    │   └── index.html      # Bulletin board view (v1)
    ├── calendar_email/
    │   └── index.html      # Calendar-integrated email view (v1)
    ├── scheduling_assist/
    │   └── index.html      # Scheduling Assist panel view (v2)
    └── triage_board/
        └── index.html      # Triage Board with urgency signals (v2)
```

---

## V2 Redesigned Prototypes

Updated versions based on CSO user testing findings, featuring a dark mode aesthetic
inspired by Superhuman/Gmail (compact, high-contrast, low visual stress).

### Switching Between Variants

| Route | Variant |
|---|---|
| `/bulletin` | V1 Bulletin Board (original) |
| `/calendar-email` | V1 Calendar Email (original) |
| `/scheduling-assist` | V2 Scheduling Assist (redesigned) |
| `/triage-board` | V2 Triage Board (redesigned) |
| `/ai-helper` | V2 AI Helper (chat + email drafting test) |

All variants are accessible from the navigation bar and landing page.
The v1 and v2 prototypes are fully independent — they share API endpoints but
have separate templates, CSS, and JS.

### Variant A: ⚡ Scheduling Assist (`/scheduling-assist`)

Replaces the old "calendar embedded in every email" with a contextual scheduling
panel that appears when relevant.

**Key features:**
- 3-column layout: Inbox → Email Detail → Scheduling Panel
- Auto-detects scheduling intent using keyword heuristics (meet, schedule, availability, etc.)
- Right-side panel shows:
  - **Suggested time slots** (top 4 overlap-first, expandable)
  - **Confidence label**: High (shared free/busy), Medium (your calendar + working hours), Low (your availability only)
  - **Privacy-first availability**: coarse free/busy view with "Show details" toggle
  - **Create holds toggle**: local UI state for holding calendar slots
  - **Draft reply preview**: auto-generates reply text with selected times
  - **Insert reply** button that populates the reply textarea
- Graceful degradation: when a contact's calendar isn't shared, shows "No calendar access" notice with medium-confidence suggestions

**Slot suggestion algorithm:**
1. Fetches your events from `/api/calendar-email/my-events` (Google Calendar API)
2. Fetches contact's free/busy from `/api/calendar-email/freebusy/<email>` (Google Calendar API)
3. Generates 30-minute free slots during working hours (9 AM – 6 PM) for the next 7 weekdays
4. Skips slots where you're busy; skips slots where they're busy (if calendar accessible)
5. Sorts: mutual overlapping free slots first, then by date/time
6. Shows top 4 by default; "More options" expands full list

### Variant B: 🎯 Triage Board (`/triage-board`)

Replaces the stressful grid of equal-weight tiles with a calmer, structured triage
experience. No timestamps shown anywhere.

**Key features:**
- 3-column layout: **Needs Reply** | **To Schedule** | **FYI / No Action**
- Compact email rows with sender, subject, snippet, and tag badges
- **Urgency scoring** (0–100) visible as colored indicators
- **1-click triage**: hover to reveal "→ Reply", "→ Schedule", "→ FYI" buttons
- **Filtering**: tag chips (Scheduling, Question, Direct, Work), search bar, "Hide mailing lists" toggle
- Stable ordering within each column based on urgency score

**Urgency scoring heuristic:**
| Signal | Points |
|---|---|
| Direct sender (not mailing list) | +20 |
| Contains question / request language | +15 |
| Contains scheduling keywords | +15 |
| Contains urgency keywords (ASAP, deadline, etc.) | +25 |
| Unread | +10 |
| Starred or Important label | +15 |
| **Max** | **100** |

When Harvard OpenAI is configured, the board attempts AI scoring first and uses this heuristic as fallback.

**Auto-bucketing:**
- Emails with scheduling keywords → "To Schedule"
- Emails with questions or urgency ≥ 35 → "Needs Reply"
- All others → "FYI / No Action"
- Users can override by clicking move buttons

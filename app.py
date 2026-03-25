"""
CSO Parallel Prototyping – Email/CMC UI
Two alternative email interfaces built on top of Gmail:

  Prototype A – Bulletin Board:  emails as pinnable cards on a spatial board
  Prototype B – Calendar Email:  click a sender → see their live availability
"""
import json
import logging
import os
import re
import threading
import time
from collections import deque
from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    redirect,
    session,
    url_for,
)
from config import SECRET_KEY
from config import TOKEN_FILE
import gmail_client
import calendar_client
import harvard_ai_client

app = Flask(__name__)
app.secret_key = SECRET_KEY

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("cso")

# ── Simple in-memory email cache (avoids re-fetching on view switch) ────
_email_cache = {}          # key = (query, max_results) -> {"emails": [...], "ts": float}
_email_cache_lock = threading.Lock()
_CACHE_TTL = 120           # seconds

# ── Per-endpoint AI rate limiting (max calls per window) ─────────────────
_AI_RATE_LIMIT = 20        # max calls
_AI_RATE_WINDOW = 60       # seconds
_ai_call_times: deque = deque()
_ai_rate_lock = threading.Lock()

_EMAIL_RE = re.compile(r'^[\w.+-]+@[\w.-]+\.\w+$')


def _get_cached_emails(query="in:inbox", max_results=40):
    """Return emails from cache if fresh, otherwise fetch and cache."""
    key = (query, max_results)
    with _email_cache_lock:
        cached = _email_cache.get(key)
        if cached and (time.time() - cached["ts"]) < _CACHE_TTL:
            return cached["emails"]
    result = gmail_client.fetch_emails(max_results=max_results, query=query)
    # fetch_emails now returns {"emails": [...], "next_page_token": ...}
    emails = result["emails"]
    next_page_token = result.get("next_page_token")
    with _email_cache_lock:
        _email_cache[key] = {"emails": emails, "next_page_token": next_page_token, "ts": time.time()}
    return emails


def _invalidate_cache():
    """Clear the email cache (call after mutations like send/delete/mark)."""
    with _email_cache_lock:
        _email_cache.clear()


def _check_ai_rate_limit():
    """Return True if the AI call is allowed, False if rate limit exceeded."""
    now = time.time()
    with _ai_rate_lock:
        while _ai_call_times and now - _ai_call_times[0] > _AI_RATE_WINDOW:
            _ai_call_times.popleft()
        if len(_ai_call_times) >= _AI_RATE_LIMIT:
            return False
        _ai_call_times.append(now)
        return True


def _validate_email(address):
    """Return True if address looks like a valid email."""
    return bool(_EMAIL_RE.match((address or "").strip()))


# ────────────────────────────────────────────────────────────────────
# Landing page – choose which prototype to explore
# ────────────────────────────────────────────────────────────────────

@app.route("/")
def landing():
    return render_template("landing.html")


# ════════════════════════════════════════════════════════════════════
# V2 PROTOTYPES  –  Updated designs from CSO user testing findings
# ════════════════════════════════════════════════════════════════════

@app.route("/scheduling-assist")
def scheduling_assist_index():
    return render_template("scheduling_assist/index.html")


@app.route("/triage-board")
def triage_board_index():
    return render_template("triage_board/index.html")


@app.route("/ai-helper")
def ai_helper_index():
    return render_template("ai_helper/index.html")


@app.route("/api/triage/score", methods=["POST"])
def api_triage_score():
    """Return optional AI urgency scoring for triage board threads."""
    if not harvard_ai_client.is_enabled():
        return jsonify({"enabled": False, "results": [], "error": "HARVARD_OPENAI_API_KEY is not configured"})
    if not _check_ai_rate_limit():
        log.warning("AI rate limit exceeded on /api/triage/score")
        return jsonify({"enabled": True, "results": [], "error": "Rate limit exceeded. Try again shortly."}), 429

    payload = request.json or {}
    threads = payload.get("threads", [])
    if not isinstance(threads, list):
        return jsonify({"enabled": True, "error": "threads must be a list"}), 400

    # Cap at 15 threads per AI call — larger batches time out on the Harvard endpoint.
    threads = threads[:15]

    try:
        scored = harvard_ai_client.score_threads(threads, include_usage=True)
        log.info("Triage scored %d threads (cached=%s)", len(threads), scored.get("cached", False))
        return jsonify({
            "enabled": True,
            "results": scored.get("results", []),
            "usage": scored.get("usage"),
            "model": scored.get("model"),
            "requestId": scored.get("id"),
            "cached": scored.get("cached", False),
        })
    except Exception as e:
        log.error("Triage score failed: %s", e)
        return jsonify({"enabled": True, "results": [], "error": str(e)}), 502


@app.route("/api/ai-helper/chat", methods=["POST"])
def api_ai_helper_chat():
    """Simple chat/email-writing helper endpoint for validating Harvard AI access."""
    if not harvard_ai_client.is_enabled():
        return jsonify({"error": "HARVARD_OPENAI_API_KEY is not configured"}), 400

    data = request.json or {}
    message = (data.get("message") or "").strip()
    mode = (data.get("mode") or "chat").strip().lower()
    history = data.get("history") or []

    if not message:
        return jsonify({"error": "message is required"}), 400
    if not isinstance(history, list):
        return jsonify({"error": "history must be a list"}), 400

    if mode == "email":
        system_prompt = (
            "You are an email writing assistant. "
            "Write concise, professional emails with clear action items. "
            "When relevant, include a subject line prefixed with 'Subject:'."
        )
    else:
        system_prompt = (
            "You are a helpful assistant for a university staff inbox workflow. "
            "Be concise, practical, and structured."
        )

    try:
        result = harvard_ai_client.chat_assistant(
            user_message=message,
            history=history,
            system_prompt=system_prompt,
        )
        return jsonify({
            "reply": result["content"],
            "model": result.get("model"),
            "requestId": result.get("id"),
            "usage": result.get("usage"),
            "cached": result.get("cached", False),
            "mode": mode,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/ai/usage")
def api_ai_usage():
    """Return aggregate Harvard AI usage details for monitoring token/credit usage."""
    try:
        summary = harvard_ai_client.get_usage_summary(
            recent_limit=int(request.args.get("recent", 20))
        )
        return jsonify({
            "enabled": harvard_ai_client.is_enabled(),
            **summary,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _extract_json_object(text):
    """Best-effort JSON extraction from model output."""
    raw = (text or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        pass

    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {}

    try:
        parsed = json.loads(raw[start : end + 1])
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _friendly_google_error(exc):
    """Convert a Google API or network exception to a readable message."""
    msg = str(exc)
    if "quota" in msg.lower() or "rateLimitExceeded" in msg:
        return "Google API quota exceeded. Please wait a moment and try again."
    if "invalid_grant" in msg or "Token has been expired" in msg:
        return "Your Google session has expired. Please log out and reconnect."
    if "HttpError 403" in msg or "insufficientPermissions" in msg:
        return "Insufficient Google permissions. Check your OAuth scopes."
    if "HttpError 404" in msg:
        return "Resource not found in Gmail."
    if "HttpError 5" in msg:
        return "Google API returned a server error. Try again shortly."
    return msg


def _coerce_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "y", "1"}:
            return True
        if normalized in {"false", "no", "n", "0"}:
            return False
    return False


@app.route("/api/scheduling-assist/intent", methods=["POST"])
def api_scheduling_assist_intent():
    """Classify whether an email is scheduling-related; AI preferred, heuristic fallback."""
    data = request.json or {}
    email = data.get("email") or {}
    if not isinstance(email, dict):
        return jsonify({"error": "email must be an object"}), 400

    subject = str(email.get("subject") or "")[:1000]
    snippet = str(email.get("snippet") or "")[:2000]
    body = str(email.get("body") or "")[:5000]

    heuristic_words = [
        "meet", "meeting", "schedule", "calendar", "availability", "available",
        "free", "slot", "time", "catch up", "coffee", "lunch", "call",
        "zoom", "sync", "office hours", "book", "when are you", "let's find",
        "propose", "reschedule",
    ]
    text = (subject + " " + snippet + " " + body).lower()
    heuristic_is_scheduling = any(word in text for word in heuristic_words)

    if not harvard_ai_client.is_enabled():
        log.info("Intent: AI not configured, using heuristic (result=%s)", heuristic_is_scheduling)
        return jsonify({
            "enabled": False,
            "isScheduling": heuristic_is_scheduling,
            "confidence": "medium" if heuristic_is_scheduling else "low",
            "source": "heuristic",
            "reason": "AI not configured; classified by keyword matching.",
        })

    if not _check_ai_rate_limit():
        log.warning("AI rate limit exceeded on /api/scheduling-assist/intent")
        return jsonify({
            "enabled": True,
            "isScheduling": heuristic_is_scheduling,
            "confidence": "medium" if heuristic_is_scheduling else "low",
            "source": "heuristic",
            "reason": "Rate limit reached; classified by keyword matching.",
        })

    system_prompt = (
        "You are an inbox intent classifier. "
        "Decide if an email is asking to schedule/reschedule a meeting or coordinate time. "
        "Return JSON only with this exact shape: "
        "{\"isScheduling\":true|false,\"confidence\":\"high|medium|low\",\"reason\":\"short reason\"}. "
        "Use true for explicit or implied coordination of dates/times/availability. "
        "Use false for informational updates, FYIs, and non-time coordination requests."
    )

    user_payload = {
        "email": {
            "subject": subject,
            "snippet": snippet,
            "body": body,
        }
    }

    try:
        result = harvard_ai_client.chat_assistant(
            user_message=json.dumps(user_payload),
            system_prompt=system_prompt,
        )
        parsed = _extract_json_object(result.get("content", ""))

        is_scheduling = _coerce_bool(parsed.get("isScheduling", False))
        confidence = str(parsed.get("confidence") or "low").strip().lower()
        if confidence not in {"high", "medium", "low"}:
            confidence = "low"
        reason = str(parsed.get("reason") or "").strip()[:200]
        if not reason:
            reason = "Classified from subject/snippet/body content."

        log.info("Intent: AI result isScheduling=%s confidence=%s cached=%s", is_scheduling, confidence, result.get("cached", False))
        return jsonify({
            "enabled": True,
            "isScheduling": is_scheduling,
            "confidence": confidence,
            "source": "ai",
            "reason": reason,
            "model": result.get("model"),
            "usage": result.get("usage"),
            "cached": result.get("cached", False),
        })
    except Exception as e:
        log.error("Intent AI call failed, falling back to heuristic: %s", e)
        return jsonify({
            "enabled": True,
            "isScheduling": heuristic_is_scheduling,
            "confidence": "medium" if heuristic_is_scheduling else "low",
            "source": "heuristic",
            "reason": "AI call failed; classified by keyword matching.",
        })


# ════════════════════════════════════════════════════════════════════
# PROTOTYPE A  –  Bulletin Board Email
# ════════════════════════════════════════════════════════════════════

@app.route("/bulletin")
def bulletin_index():
    return render_template("bulletin/index.html")


@app.route("/api/bulletin/emails")
def api_bulletin_emails():
    """Return emails structured for the bulletin board view."""
    query = request.args.get("q", "in:inbox")
    max_results = int(request.args.get("max", 40))
    try:
        emails = _get_cached_emails(query=query, max_results=max_results)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        log.error("Bulletin fetch failed: %s", e)
        return jsonify({"error": _friendly_google_error(e)}), 500

    # Group by thread so each thread becomes one "card"
    threads = {}
    for em in emails:
        tid = em["threadId"]
        if tid not in threads:
            threads[tid] = {
                "threadId": tid,
                "subject": em["subject"],
                "participants": [],
                "snippet": em["snippet"],
                "messages": [],
                "latest_date": em["date"],
                "labels": em["labels"],
                "pinned": False,
                "category": _auto_category(em),
                "isUnread": False,
            }
        threads[tid]["messages"].append(em)
        # Mark thread unread if any message is unread
        if "UNREAD" in em.get("labels", []):
            threads[tid]["isUnread"] = True
        sender = {"name": em["from_name"], "email": em["from_email"]}
        if sender not in threads[tid]["participants"]:
            threads[tid]["participants"].append(sender)
        # Also include To and Cc recipients so Reply All works
        for field in ("to", "cc"):
            for addr in _extract_addresses(em.get(field, "")):
                entry = {"name": "", "email": addr}
                if entry not in threads[tid]["participants"]:
                    threads[tid]["participants"].append(entry)

    # Retrieve next_page_token from cache if available
    key = (query, max_results)
    with _email_cache_lock:
        cached = _email_cache.get(key)
        next_page_token = cached.get("next_page_token") if cached else None

    return jsonify({"threads": list(threads.values()), "nextPageToken": next_page_token})


@app.route("/api/bulletin/thread/<thread_id>")
def api_bulletin_thread(thread_id):
    """Return full thread messages for a card expansion."""
    try:
        messages = gmail_client.fetch_thread(thread_id)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify(messages)


@app.route("/api/bulletin/send", methods=["POST"])
def api_bulletin_send():
    """Post a new 'note' (email) to the bulletin board / thread."""
    data = request.json or {}
    to = (data.get("to") or "").strip()
    subject = data.get("subject", "")
    body = data.get("body", "")
    thread_id = data.get("threadId")
    if not _validate_email(to):
        return jsonify({"error": f"Invalid recipient address: {to!r}"}), 400
    try:
        result = gmail_client.send_email(to, subject, body, thread_id=thread_id)
        _invalidate_cache()
        log.info("Bulletin send to=%s subject=%r thread=%s", to, subject, thread_id)
        return jsonify({"status": "sent", "id": result.get("id")})
    except Exception as e:
        log.error("Bulletin send failed: %s", e)
        return jsonify({"error": _friendly_google_error(e)}), 500


_ADDR_RE = re.compile(r'[\w.+-]+@[\w.-]+\.\w+')

def _extract_addresses(header_value):
    """Extract email addresses from a To/Cc header string."""
    if not header_value:
        return []
    return _ADDR_RE.findall(header_value)


def _auto_category(email):
    """Simple heuristic categorisation for bulletin board columns."""
    subject = (email.get("subject") or "").lower()
    labels = [l.lower() for l in email.get("labels", [])]

    if any(w in subject for w in ["meeting", "schedule", "calendar", "invite"]):
        return "Scheduling"
    if any(w in subject for w in ["action", "todo", "task", "deadline", "due"]):
        return "Action Items"
    if any(w in subject for w in ["idea", "proposal", "brainstorm", "suggestion"]):
        return "Ideas"
    if any(w in subject for w in ["update", "status", "report", "progress"]):
        return "Updates"
    if any(w in subject for w in ["question", "help", "ask", "?"]):
        return "Questions"
    if "STARRED" in email.get("labels", []):
        return "Important"
    return "General"


# ── Shared email actions (used by both prototypes) ──────────────────

@app.route("/api/email/mark-read", methods=["POST"])
def api_mark_read():
    """Mark a thread or message as read."""
    data = request.json
    thread_id = data.get("threadId")
    message_id = data.get("messageId")
    try:
        if thread_id:
            gmail_client.mark_thread_read(thread_id)
        elif message_id:
            gmail_client.mark_read(message_id)
        _invalidate_cache()
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/email/mark-unread", methods=["POST"])
def api_mark_unread():
    """Mark a thread or message as unread."""
    data = request.json
    thread_id = data.get("threadId")
    message_id = data.get("messageId")
    try:
        if thread_id:
            gmail_client.mark_thread_unread(thread_id)
        elif message_id:
            gmail_client.mark_unread(message_id)
        _invalidate_cache()
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/email/delete", methods=["POST"])
def api_delete_email():
    """Trash a thread or message."""
    data = request.json
    thread_id = data.get("threadId")
    message_id = data.get("messageId")
    try:
        if thread_id:
            gmail_client.trash_thread(thread_id)
        elif message_id:
            gmail_client.trash_message(message_id)
        _invalidate_cache()
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/email/star", methods=["POST"])
def api_star_email():
    """Add STARRED label to a message."""
    data = request.json or {}
    message_id = data.get("messageId")
    if not message_id:
        return jsonify({"error": "messageId is required"}), 400
    try:
        gmail_client.star_message(message_id)
        _invalidate_cache()
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/email/unstar", methods=["POST"])
def api_unstar_email():
    """Remove STARRED label from a message."""
    data = request.json or {}
    message_id = data.get("messageId")
    if not message_id:
        return jsonify({"error": "messageId is required"}), 400
    try:
        gmail_client.unstar_message(message_id)
        _invalidate_cache()
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/emails/more")
def api_emails_more():
    """Load more emails bypassing cache. Accepts q, max, pageToken query params."""
    query = request.args.get("q", "in:inbox")
    max_results = int(request.args.get("max", 40))
    page_token = request.args.get("pageToken") or None
    try:
        result = gmail_client.fetch_emails(max_results=max_results, query=query, page_token=page_token)
        return jsonify({"emails": result["emails"], "nextPageToken": result.get("next_page_token")})
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        log.error("Load more emails failed: %s", e)
        return jsonify({"error": _friendly_google_error(e)}), 500


# ════════════════════════════════════════════════════════════════════
# PROTOTYPE B  –  Calendar-Integrated Email
# ════════════════════════════════════════════════════════════════════

@app.route("/calendar-email")
def calendar_email_index():
    return render_template("calendar_email/index.html")


@app.route("/api/calendar-email/emails")
def api_calendar_emails():
    """Return emails for the calendar-email inbox view."""
    query = request.args.get("q", "in:inbox")
    max_results = int(request.args.get("max", 40))
    try:
        emails = _get_cached_emails(query=query, max_results=max_results)
        key = (query, max_results)
        with _email_cache_lock:
            cached = _email_cache.get(key)
            next_page_token = cached.get("next_page_token") if cached else None
        return jsonify({"emails": emails, "nextPageToken": next_page_token})
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        log.error("Calendar email fetch failed: %s", e)
        return jsonify({"error": _friendly_google_error(e)}), 500


@app.route("/api/calendar-email/contacts")
def api_calendar_contacts():
    """Return unique contacts extracted from recent emails."""
    try:
        emails = _get_cached_emails(query="in:inbox", max_results=60)
        contacts = gmail_client.get_contacts_from_emails(emails)
        return jsonify(contacts)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/calendar-email/availability/<path:email>")
def api_calendar_availability(email):
    """Return free/busy data for a specific contact."""
    days = int(request.args.get("days", 7))
    try:
        availability = calendar_client.compute_availability(email, days_ahead=days)
        return jsonify(availability)
    except Exception as e:
        return jsonify({"error": str(e), "email": email}), 500


@app.route("/api/calendar-email/freebusy/<path:email>")
def api_calendar_freebusy(email):
    """Return raw free/busy slots for a specific contact."""
    days = int(request.args.get("days", 7))
    try:
        fb = calendar_client.get_freebusy(email, days_ahead=days)
        return jsonify({"email": email, "busy": fb["busy"], "accessible": fb["accessible"]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/calendar-email/my-events")
def api_my_events():
    """Return the authenticated user's upcoming calendar events."""
    days = int(request.args.get("days", 7))
    try:
        events = calendar_client.get_my_events(days_ahead=days)
        return jsonify(events)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/calendar-email/send", methods=["POST"])
def api_calendar_send():
    """Send an email from the calendar-email view."""
    data = request.json or {}
    to = (data.get("to") or "").strip()
    subject = data.get("subject", "")
    body = data.get("body", "")
    thread_id = data.get("threadId")
    if not _validate_email(to):
        return jsonify({"error": f"Invalid recipient address: {to!r}"}), 400
    try:
        result = gmail_client.send_email(to, subject, body, thread_id=thread_id)
        _invalidate_cache()
        log.info("Calendar send to=%s subject=%r thread=%s", to, subject, thread_id)
        return jsonify({"status": "sent", "id": result.get("id")})
    except Exception as e:
        log.error("Calendar send failed: %s", e)
        return jsonify({"error": _friendly_google_error(e)}), 500


@app.route("/api/profile")
def api_profile():
    """Return the authenticated user's email address."""
    try:
        email = gmail_client.get_profile()
        return jsonify({"email": email})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/logout", methods=["POST"])
def api_logout():
    """Clear local OAuth token so next request requires re-authentication."""
    try:
        if os.path.exists(TOKEN_FILE):
            os.remove(TOKEN_FILE)
    except OSError:
        # Even if deletion fails, clear server-side volatile state.
        pass

    _invalidate_cache()
    harvard_ai_client.clear_response_cache()
    session.clear()
    return jsonify({"status": "ok"})


# ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Trigger OAuth on startup so the user authenticates once
    print("🔐  Authenticating with Google…")
    try:
        email = gmail_client.get_profile()
        print(f"✅  Logged in as {email}")
    except FileNotFoundError as e:
        print(f"⚠️  {e}")
        print("   Place your credentials.json in this directory and restart.")
    except Exception as e:
        print(f"⚠️  Auth error: {e}")

    print("🚀  Starting CSO Email Prototypes on http://127.0.0.1:5001")
    app.run(debug=False, port=5001)

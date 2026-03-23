"""
Gmail API client – handles OAuth flow, fetching emails, sending messages,
and organizing threads for both prototypes.
"""
import os
import json
import base64
import html as html_mod
from email.mime.text import MIMEText
from datetime import datetime, timezone

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from config import CREDENTIALS_FILE, TOKEN_FILE, SCOPES


def get_credentials():
    """Return valid Google OAuth2 credentials, refreshing or prompting as needed."""
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_FILE):
                raise FileNotFoundError(
                    f"Missing {CREDENTIALS_FILE}. Download it from Google Cloud Console "
                    "(APIs & Services → Credentials → OAuth 2.0 Client IDs)."
                )
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())

    return creds


def get_gmail_service():
    """Build and return a Gmail API service instance."""
    return build("gmail", "v1", credentials=get_credentials())


def get_profile():
    """Return the authenticated user's email address."""
    service = get_gmail_service()
    profile = service.users().getProfile(userId="me").execute()
    return profile.get("emailAddress", "")


# ── Fetching emails ─────────────────────────────────────────────────

def _parse_headers(headers):
    """Extract useful header values into a dict."""
    wanted = {"From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References"}
    return {h["name"]: h["value"] for h in headers if h["name"] in wanted}


def _strip_html(html):
    """Crude HTML → plain-text conversion (no extra deps)."""
    import re
    # Remove style/script blocks
    text = re.sub(r'<(style|script)[^>]*>.*?</\1>', '', html, flags=re.DOTALL | re.IGNORECASE)
    # Replace <br> / <p> / <div> with newlines
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</(p|div|tr|li)>', '\n', text, flags=re.IGNORECASE)
    # Strip remaining tags
    text = re.sub(r'<[^>]+>', '', text)
    # Decode common entities
    import html as html_mod
    text = html_mod.unescape(text)
    # Collapse whitespace
    lines = [l.strip() for l in text.splitlines()]
    return '\n'.join(l for l in lines if l)


def _decode_body(payload):
    """Recursively extract the plain-text (or html) body from a message payload."""
    # Direct text/plain at this level
    if payload.get("mimeType", "").startswith("text/plain") and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")

    # Depth-first search through all parts
    plain_text = None
    html_text = None

    for part in payload.get("parts", []):
        mime = part.get("mimeType", "")
        if mime == "text/plain":
            data = part.get("body", {}).get("data", "")
            if data and plain_text is None:
                plain_text = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
        elif mime == "text/html":
            data = part.get("body", {}).get("data", "")
            if data and html_text is None:
                raw = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
                html_text = _strip_html(raw)
        elif mime.startswith("multipart/"):
            # Recurse into multipart/alternative, multipart/related, multipart/mixed, etc.
            nested = _decode_body(part)
            if nested:
                # If nested gave us text, store it (prefer first found)
                if plain_text is None:
                    plain_text = nested
        # Skip attachment parts (application/*, image/*, etc.)

    if plain_text:
        return plain_text
    if html_text:
        return html_text

    # Final fallback: top-level body data (e.g. text/html at root with no parts)
    if payload.get("body", {}).get("data"):
        raw = base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")
        if payload.get("mimeType", "") == "text/html":
            return _strip_html(raw)
        return raw

    return ""


def _extract_sender_name_email(from_header):
    """Parse 'Display Name <email>' into (name, email)."""
    if "<" in from_header:
        name = from_header.split("<")[0].strip().strip('"')
        email = from_header.split("<")[1].rstrip(">").strip()
    else:
        name = from_header.strip()
        email = from_header.strip()
    return name, email


def fetch_emails(max_results=50, query=""):
    """
    Fetch recent emails from the user's inbox.
    Returns a list of dicts with id, threadId, subject, from_name, from_email,
    to, date, snippet, body, labels.
    """
    service = get_gmail_service()
    results = (
        service.users()
        .messages()
        .list(userId="me", maxResults=max_results, q=query or "in:inbox")
        .execute()
    )
    messages = results.get("messages", [])

    emails = []
    for msg_stub in messages:
        msg = (
            service.users()
            .messages()
            .get(userId="me", id=msg_stub["id"], format="full")
            .execute()
        )
        headers = _parse_headers(msg.get("payload", {}).get("headers", []))
        from_name, from_email = _extract_sender_name_email(headers.get("From", ""))
        body = _decode_body(msg.get("payload", {}))

        emails.append(
            {
                "id": msg["id"],
                "threadId": msg["threadId"],
                "subject": headers.get("Subject", "(no subject)"),
                "from_name": from_name,
                "from_email": from_email,
                "to": headers.get("To", ""),
                "cc": headers.get("Cc", ""),
                "date": headers.get("Date", ""),
                "snippet": html_mod.unescape(msg.get("snippet", "")),
                "body": body,
                "labels": msg.get("labelIds", []),
            }
        )

    return emails


def fetch_thread(thread_id):
    """Fetch all messages in a thread."""
    service = get_gmail_service()
    thread = service.users().threads().get(userId="me", id=thread_id, format="full").execute()
    messages = []
    for msg in thread.get("messages", []):
        headers = _parse_headers(msg.get("payload", {}).get("headers", []))
        from_name, from_email = _extract_sender_name_email(headers.get("From", ""))
        body = _decode_body(msg.get("payload", {}))
        messages.append(
            {
                "id": msg["id"],
                "threadId": msg["threadId"],
                "subject": headers.get("Subject", "(no subject)"),
                "from_name": from_name,
                "from_email": from_email,
                "to": headers.get("To", ""),
                "cc": headers.get("Cc", ""),
                "date": headers.get("Date", ""),
                "snippet": html_mod.unescape(msg.get("snippet", "")),
                "body": body,
                "labels": msg.get("labelIds", []),
            }
        )
    return messages


# ── Sending emails ──────────────────────────────────────────────────

def send_email(to, subject, body_text, thread_id=None):
    """Send a plain-text email. Optionally attach to an existing thread."""
    service = get_gmail_service()
    message = MIMEText(body_text)
    message["to"] = to
    message["subject"] = subject
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    body = {"raw": raw}
    if thread_id:
        body["threadId"] = thread_id
    return service.users().messages().send(userId="me", body=body).execute()


# ── Read / unread / delete helpers ──────────────────────────────────

def mark_read(message_id):
    """Remove the UNREAD label from a message."""
    service = get_gmail_service()
    return service.users().messages().modify(
        userId="me", id=message_id,
        body={"removeLabelIds": ["UNREAD"]}
    ).execute()


def mark_thread_read(thread_id):
    """Remove the UNREAD label from every message in a thread."""
    service = get_gmail_service()
    thread = service.users().threads().get(userId="me", id=thread_id, format="minimal").execute()
    for msg in thread.get("messages", []):
        if "UNREAD" in msg.get("labelIds", []):
            mark_read(msg["id"])


def mark_unread(message_id):
    """Add the UNREAD label to a message."""
    service = get_gmail_service()
    return service.users().messages().modify(
        userId="me", id=message_id,
        body={"addLabelIds": ["UNREAD"]}
    ).execute()


def mark_thread_unread(thread_id):
    """Add the UNREAD label to the latest message in a thread."""
    service = get_gmail_service()
    thread = service.users().threads().get(userId="me", id=thread_id, format="minimal").execute()
    messages = thread.get("messages", [])
    if messages:
        mark_unread(messages[-1]["id"])


def trash_message(message_id):
    """Move a message to trash."""
    service = get_gmail_service()
    return service.users().messages().trash(userId="me", id=message_id).execute()


def trash_thread(thread_id):
    """Move an entire thread to trash."""
    service = get_gmail_service()
    return service.users().threads().trash(userId="me", id=thread_id).execute()


# ── Label / category helpers ────────────────────────────────────────

def get_labels():
    """Return all Gmail labels for the authenticated user."""
    service = get_gmail_service()
    results = service.users().labels().list(userId="me").execute()
    return results.get("labels", [])


def get_contacts_from_emails(emails):
    """Extract unique contacts (name + email) from a list of email dicts."""
    contacts = {}
    for e in emails:
        key = e["from_email"].lower()
        if key not in contacts:
            contacts[key] = {
                "name": e["from_name"] or e["from_email"].split("@")[0],
                "email": e["from_email"],
            }
    return list(contacts.values())

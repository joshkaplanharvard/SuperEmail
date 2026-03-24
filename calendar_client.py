"""
Google Calendar API client – fetches free/busy data and upcoming events
for the Calendar-Integrated Email prototype.
"""
from datetime import datetime, timedelta, timezone

from googleapiclient.discovery import build

from gmail_client import get_credentials

_cached_user_tz: str | None = None


def get_calendar_service():
    """Build and return a Calendar API service instance."""
    return build("calendar", "v3", credentials=get_credentials())


def get_user_timezone() -> str:
    """Return the authenticated user's calendar timezone (e.g. 'America/New_York').
    Falls back to UTC if the setting cannot be read."""
    global _cached_user_tz
    if _cached_user_tz:
        return _cached_user_tz
    try:
        service = get_calendar_service()
        setting = service.settings().get(setting="timezone").execute()
        _cached_user_tz = setting.get("value") or "UTC"
    except Exception:
        _cached_user_tz = "UTC"
    return _cached_user_tz


def get_freebusy(email, days_ahead=7):
    """
    Query the Google Calendar free/busy API for a given email address.
    Returns a dict with:
      - "busy": list of busy time-ranges ({"start": iso, "end": iso})
      - "accessible": bool indicating if the calendar was readable
    """
    service = get_calendar_service()
    now = datetime.now(timezone.utc)
    time_min = now.isoformat()
    time_max = (now + timedelta(days=days_ahead)).isoformat()

    body = {
        "timeMin": time_min,
        "timeMax": time_max,
        "timeZone": get_user_timezone(),
        "items": [{"id": email}],
    }

    result = service.freebusy().query(body=body).execute()
    calendars = result.get("calendars", {})
    cal_data = calendars.get(email, {})
    errors = cal_data.get("errors", [])
    busy_slots = cal_data.get("busy", [])
    accessible = len(errors) == 0
    return {"busy": busy_slots, "accessible": accessible}


def get_my_events(days_ahead=7, max_results=50):
    """Fetch the authenticated user's upcoming calendar events."""
    service = get_calendar_service()
    now = datetime.now(timezone.utc).isoformat()
    time_max = (datetime.now(timezone.utc) + timedelta(days=days_ahead)).isoformat()

    events_result = (
        service.events()
        .list(
            calendarId="primary",
            timeMin=now,
            timeMax=time_max,
            maxResults=max_results,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    events = events_result.get("items", [])
    return [
        {
            "id": ev.get("id"),
            "summary": ev.get("summary", "(No title)"),
            "start": ev.get("start", {}).get("dateTime", ev.get("start", {}).get("date", "")),
            "end": ev.get("end", {}).get("dateTime", ev.get("end", {}).get("date", "")),
            "attendees": [a.get("email") for a in ev.get("attendees", [])],
            "location": ev.get("location", ""),
            "description": ev.get("description", ""),
        }
        for ev in events
    ]


def compute_availability(email, days_ahead=7):
    """
    High-level helper: return a day-by-day availability summary for a contact.
    Each day has a list of free/busy blocks for the full 24-hour period in the user's local timezone.
    Returns {"accessible": bool, "days": [...]} so the UI can hide
    calendars we cannot read.
    """
    from datetime import time as dt_time
    import pytz

    user_tz = get_user_timezone()
    local_tz = pytz.timezone(user_tz)
    fb = get_freebusy(email, days_ahead)
    busy_slots = fb["busy"]
    accessible = fb["accessible"]

    now = datetime.now(local_tz)
    days = []

    for d in range(days_ahead):
        date = (now + timedelta(days=d)).date()
        day_start = local_tz.localize(datetime.combine(date, dt_time(0, 0)))
        day_end = local_tz.localize(datetime.combine(date, dt_time(23, 59)))

        # Filter busy slots that overlap this day
        day_busy = []
        for slot in busy_slots:
            s = datetime.fromisoformat(slot["start"].replace("Z", "+00:00")).astimezone(local_tz)
            e = datetime.fromisoformat(slot["end"].replace("Z", "+00:00")).astimezone(local_tz)
            if e > day_start and s < day_end:
                clamped_start = max(s, day_start)
                clamped_end = min(e, day_end)
                day_busy.append(
                    {
                        "start": clamped_start.strftime("%I:%M %p"),
                        "end": clamped_end.strftime("%I:%M %p"),
                        "start_mins": clamped_start.hour * 60 + clamped_start.minute,
                        "end_mins": clamped_end.hour * 60 + clamped_end.minute,
                    }
                )

        days.append(
            {
                "date": date.isoformat(),
                "day_name": date.strftime("%A"),
                "busy": day_busy,
                "is_today": date == now.date(),
            }
        )

    return {"accessible": accessible, "days": days}

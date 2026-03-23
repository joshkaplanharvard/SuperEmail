"""
Configuration for the CSO Email Prototyping Project.
"""
import os


def _load_project_env_file():
    """Load key/value pairs from local .env into process env if not set."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return

    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if not key:
                    continue
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                    value = value[1:-1]
                os.environ.setdefault(key, value)
    except OSError:
        # Keep startup resilient if .env cannot be read for any reason.
        return


_load_project_env_file()

# Path to the OAuth 2.0 credentials JSON downloaded from Google Cloud Console
CREDENTIALS_FILE = os.path.join(os.path.dirname(__file__), "credentials.json")

# Where the user's OAuth token is cached after first login
TOKEN_FILE = os.path.join(os.path.dirname(__file__), "token.json")

# Scopes required for Gmail + Calendar read/write
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.freebusy",
]

# Flask secret key (change in production)
SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "cso-prototype-dev-key-change-me")

"""Harvard OpenAI gateway client used for optional triage scoring."""

import json
import os
import threading
import time
import hashlib
from typing import Any

import requests

DEFAULT_BASE_URL = "https://go.apis.huit.harvard.edu/ais-openai-direct-limited-schools/v1"
DEFAULT_MODEL = "gpt-4o-mini"

_usage_lock = threading.Lock()
_usage_totals = {
    "requests": 0,
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
}
_usage_recent: list[dict[str, Any]] = []
_usage_last_by_operation: dict[str, dict[str, Any]] = {}
_USAGE_RECENT_MAX = 100

_cache_lock = threading.Lock()
_response_cache: dict[str, dict[str, Any]] = {}
_CACHE_TTL_SECONDS = 600
_CACHE_MAX_ENTRIES = 500


def _base_url() -> str:
    return os.environ.get("HARVARD_OPENAI_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def _api_key() -> str:
    return os.environ.get("HARVARD_OPENAI_API_KEY", "").strip()


def _model() -> str:
    return os.environ.get("HARVARD_OPENAI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL


def is_enabled() -> bool:
    return bool(_api_key())


def _cache_ttl_seconds() -> int:
    raw = os.environ.get("HARVARD_OPENAI_CACHE_TTL_SECONDS", str(_CACHE_TTL_SECONDS)).strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return _CACHE_TTL_SECONDS


def _cache_max_entries() -> int:
    raw = os.environ.get("HARVARD_OPENAI_CACHE_MAX_ENTRIES", str(_CACHE_MAX_ENTRIES)).strip()
    try:
        return max(10, int(raw))
    except ValueError:
        return _CACHE_MAX_ENTRIES


def _make_cache_key(operation: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    digest = hashlib.sha256(f"{operation}:{canonical}".encode("utf-8")).hexdigest()
    return f"{operation}:{digest}"


def _get_cached_response(cache_key: str) -> dict[str, Any] | None:
    ttl = _cache_ttl_seconds()
    if ttl <= 0:
        return None

    now = time.time()
    with _cache_lock:
        item = _response_cache.get(cache_key)
        if not item:
            return None
        if (now - item["ts"]) > ttl:
            _response_cache.pop(cache_key, None)
            return None
        return dict(item["data"])


def _set_cached_response(cache_key: str, data: dict[str, Any]) -> None:
    ttl = _cache_ttl_seconds()
    if ttl <= 0:
        return

    with _cache_lock:
        _response_cache[cache_key] = {"ts": time.time(), "data": dict(data)}
        max_entries = _cache_max_entries()
        if len(_response_cache) > max_entries:
            oldest_keys = sorted(_response_cache.keys(), key=lambda k: _response_cache[k]["ts"])
            remove_count = len(_response_cache) - max_entries
            for key in oldest_keys[:remove_count]:
                _response_cache.pop(key, None)


def clear_response_cache() -> None:
    with _cache_lock:
        _response_cache.clear()


def _build_prompt_payload(threads: list[dict[str, Any]]) -> dict[str, Any]:
    compact_threads = []
    for t in threads:
        compact_threads.append(
            {
                "threadId": t.get("threadId"),
                "subject": t.get("subject", ""),
                "snippet": t.get("snippet", ""),
                "from": t.get("from", ""),
                "isUnread": bool(t.get("isUnread", False)),
                "labels": t.get("labels", []),
                "tags": t.get("tags", []),
                "heuristicUrgency": t.get("heuristicUrgency"),
                "heuristicBucket": t.get("heuristicBucket"),
            }
        )

    return {
        "model": _model(),
        "temperature": 0.1,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You classify inbox threads for triage. "
                    "Return JSON only with this exact shape: "
                    "{\"results\":[{\"threadId\":\"...\",\"urgencyStars\":1|2|3,\"bucket\":\"reply|schedule|fyi\",\"isMailingList\":true|false,\"reasons\":[\"...\",\"...\"]}]}. "
                    "Rules: urgencyStars must be 1, 2, or 3, keep reasons short, use bucket schedule for scheduling intent, "
                    "reply when user likely expects action/response, otherwise fyi."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "instructions": "Score each thread independently. Preserve every threadId in output.",
                        "threads": compact_threads,
                    }
                ),
            },
        ],
    }


def _to_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _normalize_usage(usage: Any) -> dict[str, int]:
    usage = usage if isinstance(usage, dict) else {}

    # Support common usage field names across compatible OpenAI-style responses.
    prompt_tokens = _to_int(usage.get("prompt_tokens", usage.get("input_tokens", 0)))
    completion_tokens = _to_int(usage.get("completion_tokens", usage.get("output_tokens", 0)))
    total_tokens = _to_int(usage.get("total_tokens", prompt_tokens + completion_tokens))

    if total_tokens == 0 and (prompt_tokens or completion_tokens):
        total_tokens = prompt_tokens + completion_tokens

    return {
        "prompt_tokens": max(0, prompt_tokens),
        "completion_tokens": max(0, completion_tokens),
        "total_tokens": max(0, total_tokens),
    }


def _record_usage(operation: str, data: dict[str, Any]) -> dict[str, int]:
    normalized = _normalize_usage(data.get("usage"))
    entry = {
        "ts": int(time.time()),
        "operation": operation,
        "request_id": data.get("id"),
        "model": data.get("model"),
        "usage": normalized,
    }

    with _usage_lock:
        _usage_totals["requests"] += 1
        _usage_totals["prompt_tokens"] += normalized["prompt_tokens"]
        _usage_totals["completion_tokens"] += normalized["completion_tokens"]
        _usage_totals["total_tokens"] += normalized["total_tokens"]

        _usage_recent.append(entry)
        if len(_usage_recent) > _USAGE_RECENT_MAX:
            del _usage_recent[:-_USAGE_RECENT_MAX]

        _usage_last_by_operation[operation] = entry

    return normalized


def get_usage_summary(recent_limit: int = 20) -> dict[str, Any]:
    """Return aggregate and recent usage details for credit monitoring."""
    recent_limit = max(1, min(100, int(recent_limit)))

    with _usage_lock:
        totals = dict(_usage_totals)
        recent = list(_usage_recent[-recent_limit:])
        last_by_operation = dict(_usage_last_by_operation)

    return {
        "totals": totals,
        "recent": recent,
        "lastByOperation": last_by_operation,
    }


def score_threads(
    threads: list[dict[str, Any]],
    timeout_seconds: int = 45,
    include_usage: bool = False,
) -> list[dict[str, Any]] | dict[str, Any]:
    if not is_enabled():
        raise RuntimeError("HARVARD_OPENAI_API_KEY is not configured")

    payload = _build_prompt_payload(threads)
    cache_key = _make_cache_key("triage.score", payload)
    cached = _get_cached_response(cache_key)

    if cached is not None:
        data = cached
        usage = _normalize_usage(data.get("usage"))
        cache_hit = True
    else:
        response = requests.post(
            f"{_base_url()}/chat/completions",
            headers={
                "Content-Type": "application/json",
                "api-key": _api_key(),
            },
            json=payload,
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        data = response.json()
        usage = _record_usage("triage.score", data)
        _set_cached_response(cache_key, data)
        cache_hit = False

    content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )

    parsed = _extract_json(content)
    results = parsed.get("results", []) if isinstance(parsed, dict) else []

    cleaned = []
    for item in results:
        if not isinstance(item, dict):
            continue
        thread_id = item.get("threadId")
        if not thread_id:
            continue

        stars_value = item.get("urgencyStars")
        if stars_value is None:
            # Backward compatibility if model returns the old urgency field.
            urgency_value = item.get("urgency", 0)
            try:
                urgency = int(urgency_value)
            except (TypeError, ValueError):
                urgency = 0
            if urgency >= 67:
                urgency_stars = 3
            elif urgency >= 34:
                urgency_stars = 2
            else:
                urgency_stars = 1
        else:
            try:
                urgency_stars = int(stars_value)
            except (TypeError, ValueError):
                urgency_stars = 1
        urgency_stars = max(1, min(3, urgency_stars))

        bucket = item.get("bucket", "fyi")
        if bucket not in {"reply", "schedule", "fyi"}:
            bucket = "fyi"

        reasons = item.get("reasons", [])
        if not isinstance(reasons, list):
            reasons = []
        reasons = [str(r)[:120] for r in reasons[:3]]
        is_mailing_list = bool(item.get("isMailingList", False))

        cleaned.append(
            {
                "threadId": thread_id,
                "urgencyStars": urgency_stars,
                "bucket": bucket,
                "isMailingList": is_mailing_list,
                "reasons": reasons,
            }
        )

    if include_usage:
        return {
            "results": cleaned,
            "usage": usage,
            "model": data.get("model"),
            "id": data.get("id"),
            "cached": cache_hit,
        }

    return cleaned


def chat_assistant(
    user_message: str,
    history: list[dict[str, str]] | None = None,
    system_prompt: str | None = None,
    timeout_seconds: int = 25,
) -> dict[str, Any]:
    """Send a generic chat request through Harvard's OpenAI gateway."""
    if not is_enabled():
        raise RuntimeError("HARVARD_OPENAI_API_KEY is not configured")

    history = history or []
    messages = []

    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})

    for item in history[-12:]:
        role = (item.get("role") or "").strip()
        content = item.get("content")
        if role not in {"user", "assistant"}:
            continue
        if not isinstance(content, str) or not content.strip():
            continue
        messages.append({"role": role, "content": content.strip()[:4000]})

    clean_user_message = (user_message or "").strip()
    if not clean_user_message:
        raise ValueError("user_message cannot be empty")

    messages.append({"role": "user", "content": clean_user_message[:4000]})

    payload = {
        "model": _model(),
        "temperature": 0.3,
        "messages": messages,
    }
    cache_key = _make_cache_key("chat.assistant", payload)
    cached = _get_cached_response(cache_key)

    if cached is not None:
        data = cached
        usage = _normalize_usage(data.get("usage"))
        cache_hit = True
    else:
        response = requests.post(
            f"{_base_url()}/chat/completions",
            headers={
                "Content-Type": "application/json",
                "api-key": _api_key(),
            },
            json=payload,
            timeout=timeout_seconds,
        )
        response.raise_for_status()

        data = response.json()
        usage = _record_usage("chat.assistant", data)
        _set_cached_response(cache_key, data)
        cache_hit = False
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if isinstance(content, list):
        content = "\n".join(str(part) for part in content)

    return {
        "content": str(content).strip(),
        "model": data.get("model"),
        "id": data.get("id"),
        "usage": usage,
        "cached": cache_hit,
    }


def _extract_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {"results": []}

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {"results": []}

    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {"results": []}

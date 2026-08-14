#!/usr/bin/env python3
"""Submit the sitemap and import privacy-minimized Google Search Console metrics."""

from __future__ import annotations

import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


STATE_PATH = Path("/var/lib/hermes-affiliate-engine/gsc-status.json")
REQUIRED = ("GSC_CLIENT_ID", "GSC_CLIENT_SECRET", "GSC_REFRESH_TOKEN")
PRESERVED_WEB_EVIDENCE = (
    "pages", "clicks", "impressions", "ctr_pct", "avg_position",
    "web_verified_at", "sitemap_status", "sitemap_discovered_pages",
    "excluded_pages", "excluded_reasons", "page_metrics",
)
PUBLIC_CONTENT_PREFIXES = ("/software/", "/guides/", "/compare/", "/tools/")


def configured_public_prefixes() -> tuple[str, ...]:
    raw = os.getenv("GSC_PUBLIC_CONTENT_PREFIXES", "").strip()
    if not raw:
        return PUBLIC_CONTENT_PREFIXES
    return tuple(
        value for value in (item.strip() for item in raw.split(","))
        if value.startswith("/") and "?" not in value and "#" not in value
    ) or PUBLIC_CONTENT_PREFIXES


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o640)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def request_json(url: str, *, data: bytes | None = None, method: str | None = None,
                 headers: dict[str, str] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read()
        return json.loads(body.decode()) if body else {}


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    clicks = sum(float(row.get("clicks") or 0) for row in rows)
    impressions = sum(float(row.get("impressions") or 0) for row in rows)
    weighted_position = sum(float(row.get("position") or 0) * float(row.get("impressions") or 0)
                            for row in rows)
    return {
        "pages": len(rows), "clicks": round(clicks), "impressions": round(impressions),
        "ctr_pct": round(clicks / impressions * 100, 2) if impressions else 0,
        "avg_position": round(weighted_position / impressions, 2) if impressions else 0,
    }


def public_page_metrics(rows: list[dict[str, Any]], base_url: str,
                        prefixes: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
    """Return only aggregate, same-host B2B page metrics; never retain queries or visitors."""
    base = urllib.parse.urlsplit(base_url)
    if base.scheme != "https" or not base.hostname:
        return []
    allowed_prefixes = prefixes or configured_public_prefixes()
    totals: dict[str, dict[str, float]] = {}
    for row in rows:
        keys = row.get("keys")
        if not isinstance(keys, list) or len(keys) != 1 or not isinstance(keys[0], str):
            continue
        parsed = urllib.parse.urlsplit(keys[0])
        if (parsed.scheme != "https" or parsed.hostname != base.hostname
                or parsed.port != base.port or parsed.query or parsed.fragment
                or not parsed.path.startswith(allowed_prefixes)):
            continue
        clicks = max(0.0, float(row.get("clicks") or 0))
        impressions = max(0.0, float(row.get("impressions") or 0))
        position = max(0.0, float(row.get("position") or 0))
        item = totals.setdefault(parsed.path, {
            "clicks": 0.0, "impressions": 0.0, "weighted_position": 0.0,
        })
        item["clicks"] += clicks
        item["impressions"] += impressions
        item["weighted_position"] += position * impressions
    result = []
    for path, item in totals.items():
        impressions = item["impressions"]
        clicks = item["clicks"]
        result.append({
            "path": path,
            "clicks": round(clicks),
            "impressions": round(impressions),
            "ctr_pct": round(clicks / impressions * 100, 2) if impressions else 0,
            "avg_position": round(item["weighted_position"] / impressions, 2)
            if impressions else 0,
        })
    return sorted(result, key=lambda item: (-item["impressions"], item["path"]))[:250]


def existing_web_evidence(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        key: payload[key]
        for key in PRESERVED_WEB_EVIDENCE
        if key in payload
    }


def sync(state_path: Path = STATE_PATH) -> int:
    stamp = datetime.now(timezone.utc)
    missing = [key for key in REQUIRED if not os.getenv(key, "").strip()]
    if missing:
        atomic_json(state_path, {
            "status": "human-gate", "updated_at": stamp.isoformat(timespec="seconds"),
            "missing": missing,
            "message": (
                "Open the Google consent screen and complete Advanced > "
                "Continue to Haru Project (unsafe) > Continue > Allow once"
            ),
            **existing_web_evidence(state_path),
        })
        return 0
    try:
        base = os.environ["PUBLIC_BASE_URL"].rstrip("/")
        site_url = os.getenv("GSC_SITE_URL", base + "/")
        token_payload = urllib.parse.urlencode({
            "client_id": os.environ["GSC_CLIENT_ID"],
            "client_secret": os.environ["GSC_CLIENT_SECRET"],
            "refresh_token": os.environ["GSC_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        }).encode()
        token = request_json(
            "https://oauth2.googleapis.com/token", data=token_payload,
            method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        access_token = str(token.get("access_token") or "").strip()
        if not access_token:
            raise ValueError("access token unavailable")
        authorization = {"Authorization": f"Bearer {access_token}"}
        quoted_site = urllib.parse.quote(site_url, safe="")
        sitemap_url = base + "/sitemap.xml"
        quoted_sitemap = urllib.parse.quote(sitemap_url, safe="")
        request_json(
            f"https://www.googleapis.com/webmasters/v3/sites/{quoted_site}/sitemaps/{quoted_sitemap}",
            data=b"", method="PUT", headers=authorization,
        )
        end = (stamp - timedelta(days=2)).date()
        start = end - timedelta(days=27)
        query = json.dumps({
            "startDate": start.isoformat(), "endDate": end.isoformat(),
            "dimensions": ["page"], "rowLimit": 25000,
        }).encode()
        report = request_json(
            f"https://www.googleapis.com/webmasters/v3/sites/{quoted_site}/searchAnalytics/query",
            data=query, method="POST",
            headers={**authorization, "Content-Type": "application/json; charset=utf-8"},
        )
        rows = report.get("rows", [])
        if not isinstance(rows, list):
            raise ValueError("invalid Search Console rows")
        metrics = aggregate(rows)
        atomic_json(state_path, {
            "status": "ok", "updated_at": stamp.isoformat(timespec="seconds"),
            "site_url": site_url, "sitemap_url": sitemap_url,
            "period_start": start.isoformat(), "period_end": end.isoformat(), **metrics,
            "page_metrics": public_page_metrics(rows, base),
        })
        return 0
    except urllib.error.HTTPError as exc:
        status = "authorization-error" if exc.code in {401, 403} else "api-error"
        safe_error = f"Google API HTTP {int(exc.code)}"
    except (urllib.error.URLError, TimeoutError) as exc:
        status = "network-error"
        safe_error = type(exc).__name__
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        status = "response-error"
        safe_error = str(exc)[:120]
    atomic_json(state_path, {
        "status": status,
        "updated_at": stamp.isoformat(timespec="seconds"),
        "message": safe_error,
        **existing_web_evidence(state_path),
    })
    return 1


if __name__ == "__main__":
    raise SystemExit(sync(Path(os.getenv("GSC_STATE_PATH", str(STATE_PATH)))))

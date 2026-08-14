#!/usr/bin/env python3
"""Authorize Search Console through a localhost-only, PKCE-protected callback."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import shlex
import stat
import tempfile
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
GSC_SCOPE = "https://www.googleapis.com/auth/webmasters"
DEFAULT_CLIENT_PATH = Path("/etc/hermes-affiliate-youtube-oauth.json")
DEFAULT_ENV_PATH = Path("/var/lib/hermes-affiliate-engine/gsc-credentials.env")
DEFAULT_STATUS_PATH = Path("/var/lib/hermes-affiliate-engine/gsc-oauth-request.json")


def serve_until_oauth_result(server: ThreadingHTTPServer,
                             result: dict[str, str],
                             timeout_seconds: float = 600.0) -> None:
    """Ignore browser preconnect/favicon requests until OAuth actually resolves."""
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while not result.get("code") and not result.get("error"):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        server.timeout = min(1.0, remaining)
        server.handle_request()


def _clean_secret(value: Any, label: str) -> str:
    result = str(value or "").strip()
    if not result or len(result) > 4096 or any(char in result for char in "\r\n\x00"):
        raise ValueError(f"invalid {label}")
    return result


def load_client(path: Path) -> dict[str, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("invalid OAuth client document")
    return {
        "client_id": _clean_secret(payload.get("client_id"), "client_id"),
        "client_secret": _clean_secret(payload.get("client_secret"), "client_secret"),
    }


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def authorization_url(client_id: str, redirect_uri: str, state: str,
                      challenge: str) -> str:
    query = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": GSC_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    return f"{AUTH_ENDPOINT}?{query}"


def exchange_code(client: dict[str, str], code: str, redirect_uri: str,
                  verifier: str) -> dict[str, Any]:
    body = urllib.parse.urlencode({
        "client_id": client["client_id"],
        "client_secret": client["client_secret"],
        "code": _clean_secret(code, "authorization code"),
        "code_verifier": verifier,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode()
    request = urllib.request.Request(
        TOKEN_ENDPOINT, data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("invalid token response")
    return payload


def install_gsc_credentials(path: Path, client: dict[str, str],
                            refresh_token: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    current_stat = path.lstat() if path.exists() else None
    if current_stat is not None and not stat.S_ISREG(current_stat.st_mode):
        raise ValueError("environment path must be a regular file")
    values = {
        "GSC_CLIENT_ID": _clean_secret(client["client_id"], "client_id"),
        "GSC_CLIENT_SECRET": _clean_secret(client["client_secret"], "client_secret"),
        "GSC_REFRESH_TOKEN": _clean_secret(refresh_token, "refresh_token"),
    }
    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    kept = [
        line for line in existing
        if not any(line.startswith(f"{key}=") for key in values)
    ]
    rendered = kept + [f"{key}={shlex.quote(value)}" for key, value in values.items()]
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write("\n".join(rendered).rstrip() + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(current_stat.st_mode) if current_stat else 0o640)
        if current_stat is not None and hasattr(os, "chown"):
            os.chown(temporary, current_stat.st_uid, current_stat.st_gid)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def atomic_status(path: Path, payload: dict[str, Any]) -> None:
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


def run() -> int:
    host = "127.0.0.1"
    port = int(os.getenv("GSC_OAUTH_PORT", "8765"))
    if not 1024 <= port <= 65535:
        raise ValueError("invalid callback port")
    client_path = Path(os.getenv("GSC_OAUTH_CLIENT_PATH", str(DEFAULT_CLIENT_PATH)))
    env_path = Path(os.getenv("GSC_OAUTH_ENV_PATH", str(DEFAULT_ENV_PATH)))
    status_path = Path(os.getenv("GSC_OAUTH_STATUS_PATH", str(DEFAULT_STATUS_PATH)))
    client = load_client(client_path)
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    redirect_uri = f"http://{host}:{port}/callback"
    url = authorization_url(client["client_id"], redirect_uri, state,
                            pkce_challenge(verifier))
    result: dict[str, str] = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path != "/callback" or (query.get("state") or [""])[0] != state:
                self.send_response(400)
                body = b"Invalid OAuth callback."
            elif query.get("error"):
                result["error"] = str(query["error"][0])[:120]
                self.send_response(400)
                body = b"Google authorization was not completed. You may close this tab."
            else:
                result["code"] = str((query.get("code") or [""])[0])
                self.send_response(200)
                body = ("Search Console authorization received. Return to Codex; "
                        "this tab can be closed.").encode()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    atomic_status(status_path, {
        "status": "awaiting-user-consent",
        "authorization_url": url,
        "callback": redirect_uri,
        "scope": GSC_SCOPE,
        "secret_values_exposed": False,
    })
    server = ThreadingHTTPServer((host, port), Callback)
    try:
        serve_until_oauth_result(server, result)
    finally:
        server.server_close()
    if not result.get("code"):
        atomic_status(status_path, {
            "status": "not-authorized",
            "error": result.get("error") or "callback timeout",
            "secret_values_exposed": False,
        })
        return 1
    token = exchange_code(client, result["code"], redirect_uri, verifier)
    granted = set(str(token.get("scope") or "").split())
    if GSC_SCOPE not in granted:
        raise ValueError("Search Console read/write scope was not granted")
    install_gsc_credentials(env_path, client, token.get("refresh_token"))
    atomic_status(status_path, {
        "status": "installed",
        "scope": GSC_SCOPE,
        "secret_values_exposed": False,
    })
    print("gsc oauth installed; secret values not displayed")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())

import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from connect_gsc_oauth import (
    GSC_SCOPE,
    authorization_url,
    install_gsc_credentials,
    load_client,
    pkce_challenge,
    serve_until_oauth_result,
)


class ConnectGscOauthTests(unittest.TestCase):
    def test_callback_server_ignores_preconnect_until_code_arrives(self):
        result = {}

        class FakeServer:
            timeout = None
            calls = 0

            def handle_request(self):
                self.calls += 1
                if self.calls == 2:
                    result["code"] = "authorization-code"

        server = FakeServer()
        serve_until_oauth_result(server, result, timeout_seconds=2)
        self.assertEqual(2, server.calls)
        self.assertEqual("authorization-code", result["code"])

    def test_authorization_url_uses_pkce_full_scope_and_no_secret(self):
        url = authorization_url(
            "client.apps.googleusercontent.com",
            "http://127.0.0.1:8765/callback",
            "state-value", pkce_challenge("v" * 64),
        )
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertEqual(query["scope"], [GSC_SCOPE])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["access_type"], ["offline"])
        self.assertEqual(query["prompt"], ["consent"])
        self.assertNotIn("client_secret", query)

    def test_load_client_accepts_only_flat_existing_client_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "client.json"
            path.write_text(json.dumps({
                "client_id": "client-id",
                "client_secret": "client-secret",
                "refresh_token": "existing-youtube-token",
            }), encoding="utf-8")
            self.assertEqual(load_client(path), {
                "client_id": "client-id", "client_secret": "client-secret",
            })

    def test_install_is_atomic_deduplicated_and_preserves_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "engine.env"
            path.write_text(
                "PUBLIC_BASE_URL=https://deals.example\n"
                "GSC_CLIENT_ID=old\nGSC_REFRESH_TOKEN=old\nGSC_CLIENT_ID=duplicate\n",
                encoding="utf-8",
            )
            os.chmod(path, 0o640)
            install_gsc_credentials(path, {
                "client_id": "new-client", "client_secret": "new-secret",
            }, "new-refresh")
            text = path.read_text(encoding="utf-8")
            self.assertEqual(text.count("GSC_CLIENT_ID="), 1)
            self.assertEqual(text.count("GSC_CLIENT_SECRET="), 1)
            self.assertEqual(text.count("GSC_REFRESH_TOKEN="), 1)
            self.assertIn("PUBLIC_BASE_URL=https://deals.example", text)
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)

    def test_install_rejects_newlines_in_secret_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "engine.env"
            path.write_text("SAFE=value\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid refresh_token"):
                install_gsc_credentials(path, {
                    "client_id": "client", "client_secret": "secret",
                }, "bad\nvalue")


if __name__ == "__main__":
    unittest.main()

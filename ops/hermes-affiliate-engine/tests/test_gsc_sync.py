import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gsc_sync import aggregate, public_page_metrics, sync


class GscSyncTests(unittest.TestCase):
    def test_missing_oauth_is_an_explicit_human_gate(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {}, clear=True):
            state = Path(tmp) / "gsc.json"
            self.assertEqual(sync(state), 0)
            payload = json.loads(state.read_text())
            self.assertEqual(payload["status"], "human-gate")
            self.assertEqual(set(payload["missing"]), {
                "GSC_CLIENT_ID", "GSC_CLIENT_SECRET", "GSC_REFRESH_TOKEN"})

    def test_missing_oauth_preserves_verified_web_evidence(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {}, clear=True):
            state = Path(tmp) / "gsc.json"
            state.write_text(json.dumps({
                "status": "human-gate",
                "pages": 21,
                "impressions": 0,
                "clicks": 0,
                "web_verified_at": "2026-07-28T05:30:00+00:00",
                "sitemap_status": "success",
                "sitemap_discovered_pages": 333,
                "excluded_pages": 162,
                "excluded_reasons": {
                    "not_found": 4, "discovered_not_indexed": 101,
                    "crawled_not_indexed": 57,
                },
                "page_metrics": [{"path": "/guides/kept", "impressions": 8}],
            }), encoding="utf-8")
            self.assertEqual(sync(state), 0)
            payload = json.loads(state.read_text())
            self.assertEqual(payload["status"], "human-gate")
            self.assertEqual(payload["pages"], 21)
            self.assertEqual(payload["sitemap_status"], "success")
            self.assertEqual(payload["excluded_reasons"]["crawled_not_indexed"], 57)
            self.assertEqual(payload["page_metrics"][0]["path"], "/guides/kept")

    def test_http_authorization_error_is_sanitized_and_preserves_evidence(self):
        env = {
            "GSC_CLIENT_ID": "client-id",
            "GSC_CLIENT_SECRET": "do-not-record-this-secret",
            "GSC_REFRESH_TOKEN": "do-not-record-this-token",
            "PUBLIC_BASE_URL": "https://deals.example",
        }
        error = urllib.error.HTTPError(
            "https://google.example/private?token=do-not-record-this-token",
            403, "forbidden", {}, io.BytesIO(b'{"private":"body"}'),
        )
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ, env, clear=True
        ), mock.patch("gsc_sync.request_json", side_effect=error):
            state = Path(tmp) / "gsc.json"
            state.write_text(json.dumps({
                "pages": 7, "impressions": 13,
                "page_metrics": [{"path": "/guides/kept", "impressions": 13}],
            }), encoding="utf-8")
            self.assertEqual(sync(state), 1)
            payload = json.loads(state.read_text())
        serialized = json.dumps(payload)
        self.assertEqual(payload["status"], "authorization-error")
        self.assertEqual(payload["message"], "Google API HTTP 403")
        self.assertEqual(payload["pages"], 7)
        self.assertEqual(payload["page_metrics"][0]["path"], "/guides/kept")
        self.assertNotIn("do-not-record", serialized)
        self.assertNotIn("private", serialized)

    def test_invalid_token_response_is_recorded_without_crashing(self):
        env = {
            "GSC_CLIENT_ID": "client-id",
            "GSC_CLIENT_SECRET": "client-secret",
            "GSC_REFRESH_TOKEN": "refresh-token",
            "PUBLIC_BASE_URL": "https://deals.example",
        }
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ, env, clear=True
        ), mock.patch("gsc_sync.request_json", return_value={}):
            state = Path(tmp) / "gsc.json"
            self.assertEqual(sync(state), 1)
            payload = json.loads(state.read_text())
        self.assertEqual(payload["status"], "response-error")
        self.assertEqual(payload["message"], "access token unavailable")

    def test_aggregate_uses_page_totals_without_search_queries(self):
        metrics = aggregate([
            {"keys": ["https://example/a"], "clicks": 2, "impressions": 10,
             "ctr": 0.2, "position": 3},
            {"keys": ["https://example/b"], "clicks": 1, "impressions": 5,
             "ctr": 0.2, "position": 9},
        ])
        self.assertEqual(metrics, {"pages": 2, "clicks": 3, "impressions": 15,
                                   "ctr_pct": 20.0, "avg_position": 5.0})

    def test_public_page_metrics_keeps_only_same_host_b2b_paths(self):
        rows = [
            {"keys": ["https://deals.example/guides/email-tools"],
             "clicks": 1, "impressions": 20, "position": 8},
            {"keys": ["https://deals.example/guides/email-tools"],
             "clicks": 1, "impressions": 10, "position": 14},
            {"keys": ["https://deals.example/software/snovio?person=1"],
             "clicks": 2, "impressions": 30, "position": 3},
            {"keys": ["https://other.example/compare/a-vs-b"],
             "clicks": 3, "impressions": 40, "position": 2},
            {"keys": ["https://deals.example/deal/7"],
             "clicks": 4, "impressions": 50, "position": 1},
            {"keys": ["private search query", "https://deals.example/tools/a"],
             "clicks": 9, "impressions": 90, "position": 1},
        ]
        result = public_page_metrics(rows, "https://deals.example")
        self.assertEqual(result, [{
            "path": "/guides/email-tools", "clicks": 2, "impressions": 30,
            "ctr_pct": 6.67, "avg_position": 10.0,
        }])

    def test_public_page_metrics_supports_haru_editorial_prefixes(self):
        rows = [
            {"keys": ["https://worldharu.com/culture-argentina"],
             "clicks": 2, "impressions": 25, "position": 7},
            {"keys": ["https://worldharu.com/en/culture-argentina"],
             "clicks": 1, "impressions": 10, "position": 9},
            {"keys": ["https://worldharu.com/api/health"],
             "clicks": 9, "impressions": 90, "position": 1},
        ]
        with mock.patch.dict(os.environ, {
            "GSC_PUBLIC_CONTENT_PREFIXES": "/culture,/en/culture",
        }, clear=False):
            result = public_page_metrics(rows, "https://worldharu.com")
        self.assertEqual([item["path"] for item in result], [
            "/culture-argentina", "/en/culture-argentina",
        ])


if __name__ == "__main__":
    unittest.main()

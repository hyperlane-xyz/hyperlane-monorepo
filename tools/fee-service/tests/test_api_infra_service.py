import json
import time
import unittest
import importlib.util
from tempfile import TemporaryDirectory
from pathlib import Path
from unittest.mock import patch

if importlib.util.find_spec("flask") is not None:
    import app as app_module
    _FLASK_AVAILABLE = True
else:
    app_module = None
    _FLASK_AVAILABLE = False


def _sample_config():
    return {
        "scan_frequency": {"gas_prices_minutes": 15},
        "chains": {
            "ethereum": {"type": "evm", "native": "ethereum"},
            "base": {"type": "evm", "native": "ethereum"},
        },
        "igp_submission": {"managed_chains": ["ethereum", "base"]},
    }


def _sample_scan_payload(ts: float) -> dict:
    return {
        "timestamp": ts,
        "generated_at": "2026-03-14T00:00:00+00:00",
        "delivery_costs": {
            "ethereum": {"igp_quote_usd": 0.12},
            "base": {"igp_quote_usd": 0.09},
        },
        "igp_recommendations": {
            "ethereum->base": {
                "remote_chain": "base",
                "gas_price": 123,
                "decimals": 9,
                "token_exchange_rate": 456,
            }
        },
        "warp_recommendations": {
            "USDC:ethereum->base": {
                "recommended_bps": 4.5,
                "rationale": "competitive",
            }
        },
    }


@unittest.skipUnless(_FLASK_AVAILABLE, "flask is not installed")
class InfraServiceApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.latest_scan = Path(self.tmp.name) / "latest_scan.json"
        self.snapshots_dir = Path(self.tmp.name) / "infra_snapshots"
        self.refresh_dir = Path(self.tmp.name) / "infra_refresh_jobs"
        self.client = app_module.app.test_client()
        app_module.app.config["TESTING"] = True
        app_module.app.config["FEE_SYSTEM_CONFIG"] = _sample_config()
        app_module.app.config["INFRA_SNAPSHOTS_DIR"] = str(self.snapshots_dir)
        app_module.app.config["INFRA_REFRESH_JOBS_DIR"] = str(self.refresh_dir)
        self.scan_patcher = patch.object(app_module, "LATEST_SCAN", self.latest_scan)
        self.scan_patcher.start()
        self.cmd_scan_patcher = patch.object(app_module, "cmd_scan", side_effect=self._fake_cmd_scan)
        self.cmd_scan_patcher.start()

    def tearDown(self):
        self.cmd_scan_patcher.stop()
        self.scan_patcher.stop()
        app_module.app.config.pop("FEE_SYSTEM_CONFIG", None)
        app_module.app.config.pop("INFRA_SNAPSHOTS_DIR", None)
        app_module.app.config.pop("INFRA_REFRESH_JOBS_DIR", None)
        self.tmp.cleanup()

    def _fake_cmd_scan(self, args, config):
        payload = _sample_scan_payload(time.time())
        self.latest_scan.write_text(json.dumps(payload))
        return payload

    def _wait_for_refresh(self, job_id: str) -> dict:
        for _ in range(100):
            resp = self.client.get(f"/api/infra/refresh/{job_id}")
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            if body["status"] in {"completed", "failed"}:
                return body
            time.sleep(0.05)
        self.fail("refresh job did not complete")

    def test_refresh_creates_snapshot_and_serves_latest_payloads(self):
        submit = self.client.post("/api/infra/refresh", json={"requested_by": "test"})
        self.assertEqual(submit.status_code, 202)
        job_id = submit.get_json()["job_id"]

        status = self._wait_for_refresh(job_id)
        self.assertEqual("completed", status["status"])
        self.assertIsNotNone(status["snapshot_id"])

        latest = self.client.get("/api/infra/snapshots/latest")
        self.assertEqual(latest.status_code, 200)
        latest_payload = latest.get_json()
        self.assertEqual(status["snapshot_id"], latest_payload["snapshot_id"])

        igp = self.client.get("/api/infra/snapshots/latest/igp-config")
        self.assertEqual(igp.status_code, 200)
        igp_payload = igp.get_json()
        self.assertIn("gas_prices", igp_payload["config"])
        self.assertIn("floor_overrides", igp_payload["config"])

        warp = self.client.get("/api/infra/snapshots/latest/warp-config")
        self.assertEqual(warp.status_code, 200)
        self.assertIn("routes", warp.get_json()["config"])

        bundle = self.client.get("/api/infra/snapshots/latest/config-bundle")
        self.assertEqual(bundle.status_code, 200)
        self.assertIn("igp", bundle.get_json()["config"])
        self.assertIn("warp", bundle.get_json()["config"])

    def test_status_reports_latest_snapshot_and_refresh_state(self):
        before = self.client.get("/api/infra/status")
        self.assertEqual(before.status_code, 200)
        self.assertIsNone(before.get_json()["latest_snapshot"])

        submit = self.client.post("/api/infra/refresh", json={})
        self.assertEqual(submit.status_code, 202)
        status = self._wait_for_refresh(submit.get_json()["job_id"])
        self.assertEqual("completed", status["status"])

        after = self.client.get("/api/infra/status")
        self.assertEqual(after.status_code, 200)
        body = after.get_json()
        self.assertEqual(status["snapshot_id"], body["latest_snapshot"]["snapshot_id"])
        self.assertFalse(body["refresh"]["running"])

    def test_by_id_reads_match_latest(self):
        submit = self.client.post("/api/infra/refresh", json={})
        self.assertEqual(submit.status_code, 202)
        status = self._wait_for_refresh(submit.get_json()["job_id"])
        snapshot_id = status["snapshot_id"]

        latest = self.client.get("/api/infra/snapshots/latest/config-bundle")
        by_id = self.client.get(f"/api/infra/snapshots/{snapshot_id}/config-bundle")
        self.assertEqual(latest.status_code, 200)
        self.assertEqual(by_id.status_code, 200)
        self.assertEqual(latest.get_json()["config"], by_id.get_json()["config"])

    def test_unknown_snapshot_returns_404(self):
        resp = self.client.get("/api/infra/snapshots/nope")
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()

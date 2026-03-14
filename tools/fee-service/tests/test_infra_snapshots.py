import unittest
from tempfile import TemporaryDirectory

from engine.infra_snapshots import (
    create_refresh_job,
    create_snapshot,
    load_refresh_job,
    load_snapshot,
    snapshot_freshness,
    update_refresh_job,
)


def _sample_config():
    return {
        "chains": {
            "ethereum": {"type": "evm", "native": "ethereum"},
            "base": {"type": "evm", "native": "ethereum"},
        },
        "igp_submission": {"managed_chains": ["ethereum", "base"]},
    }


def _sample_scan():
    return {
        "timestamp": 1700000000,
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


class InfraSnapshotsTests(unittest.TestCase):
    def test_create_and_load_snapshot(self):
        with TemporaryDirectory() as tmpdir:
            created = create_snapshot(_sample_scan(), _sample_config(), snapshots_dir=tmpdir)
            loaded = load_snapshot(created["snapshot_id"], snapshots_dir=tmpdir)
            latest = load_snapshot("latest", snapshots_dir=tmpdir)

            self.assertEqual(created["snapshot_id"], loaded["snapshot_id"])
            self.assertEqual(created["snapshot_id"], latest["snapshot_id"])
            self.assertEqual(4.5, latest["warp"]["routes"]["USDC:ethereum->base"]["bps"])

    def test_refresh_jobs_persist_state(self):
        with TemporaryDirectory() as tmpdir:
            job = create_refresh_job(refresh_jobs_dir=tmpdir, requested_by="test")
            self.assertEqual("queued", job["status"])
            updated = update_refresh_job(
                job["job_id"],
                refresh_jobs_dir=tmpdir,
                status="completed",
                snapshot_id="snap-1",
            )
            self.assertEqual("completed", updated["status"])
            self.assertEqual("snap-1", load_refresh_job(job["job_id"], refresh_jobs_dir=tmpdir)["snapshot_id"])

    def test_snapshot_freshness_computes_age(self):
        manifest = {"created_at": "2026-03-14T00:00:00+00:00"}
        freshness = snapshot_freshness(manifest, stale_after_seconds=1)
        self.assertIn("age_seconds", freshness)
        self.assertIn("is_stale", freshness)


if __name__ == "__main__":
    unittest.main()

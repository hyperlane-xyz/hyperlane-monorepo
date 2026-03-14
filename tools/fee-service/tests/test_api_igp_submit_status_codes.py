import unittest
from unittest.mock import patch

import app as app_module
from engine.igp_submission import IGPSubmissionError


class IGPSubmitApiStatusTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_submit_returns_200_for_dry_run_aborted(self):
        with (
            patch.object(app_module, "load_config", return_value={}),
            patch.object(
                app_module,
                "submit_proposal",
                return_value={
                    "proposal_id": "p1",
                    "status": "aborted",
                    "status_reason": "dry_run_aborted",
                    "submission": {},
                },
            ),
        ):
            resp = self.client.post(
                "/api/igp/proposals/p1/submit",
                json={"confirmation_phrase": "APPLY IGP UPDATE", "dry_run": True},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["status_reason"], "dry_run_aborted")

    def test_submit_returns_422_for_validation_preflight_error(self):
        with (
            patch.object(app_module, "load_config", return_value={}),
            patch.object(
                app_module,
                "submit_proposal",
                side_effect=IGPSubmissionError("Proposal validation failed: stale proposal"),
            ),
        ):
            resp = self.client.post(
                "/api/igp/proposals/p1/submit",
                json={"confirmation_phrase": "APPLY IGP UPDATE"},
            )
        self.assertEqual(resp.status_code, 422)

    def test_submit_returns_500_for_command_failure(self):
        with (
            patch.object(app_module, "load_config", return_value={}),
            patch.object(
                app_module,
                "submit_proposal",
                return_value={
                    "proposal_id": "p1",
                    "status": "failed",
                    "status_reason": "command_failed",
                    "submission": {"exit_code": 1},
                },
            ),
        ):
            resp = self.client.post(
                "/api/igp/proposals/p1/submit",
                json={"confirmation_phrase": "APPLY IGP UPDATE"},
            )
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(resp.get_json()["status_reason"], "command_failed")


if __name__ == "__main__":
    unittest.main()

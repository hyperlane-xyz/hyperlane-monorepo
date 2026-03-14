import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from engine import igp_submission


class IGPSubmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.proposals_dir = self.root / "igp_proposals"
        self.audit_log = self.root / "audit" / "igp_submissions.jsonl"
        self.latest_scan = self.root / "latest_scan.json"
        self.monorepo = self.root / "hyperlane-monorepo"
        self.monorepo.mkdir(parents=True, exist_ok=True)

        self.proposals_dir.mkdir(parents=True, exist_ok=True)
        self.latest_scan.write_text(
            json.dumps(
                {
                    "timestamp": time.time(),
                    "gas_prices": {"ethereum": {"gas_price_gwei": 12.3}},
                    "token_prices": {"ethereum": {"usd": 3500}},
                }
            )
        )

        self.config = {
            "safety": {
                "circuit_breaker_fail_pct": 50,
                "circuit_breaker_price_move_pct": 30,
            },
            "chains": {
                "ethereum": {"type": "evm", "native": "ethereum"},
            },
            "igp_submission": {
                "monorepo_path": str(self.monorepo),
                "managed_chains": ["ethereum"],
                "review_requires_phrase": "APPLY IGP UPDATE",
                "sealevel_mode": "manual_edit_required",
                "max_proposal_age_minutes": 60,
                "max_delta_pct": 200,
                "execution_backend": "deploy",
                "deploy_concurrent": True,
                "disable_monorepo_min_usd_floor": True,
            },
        }

        self.path_patchers = [
            patch.object(igp_submission, "PROPOSALS_DIR", self.proposals_dir),
            patch.object(igp_submission, "AUDIT_LOG", self.audit_log),
            patch.object(igp_submission, "LATEST_SCAN", self.latest_scan),
            patch.object(
                igp_submission,
                "_validate_monorepo_runtime_artifacts",
                return_value=None,
            ),
        ]
        for patcher in self.path_patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.path_patchers):
            patcher.stop()
        self.tmp.cleanup()

    def _write_proposal(
        self,
        proposal_id: str = "igp-test",
        status: str = "approved",
        idempotency_key: str = "idem-1",
        version: int = 1,
        approved_version: int = 1,
        base_scan_timestamp: float | None = None,
    ) -> dict:
        payload = {
            "proposal_id": proposal_id,
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "status": status,
            "version": version,
            "operator": "test",
            "managed_chains": ["ethereum"],
            "base_scan_timestamp": (
                base_scan_timestamp if base_scan_timestamp is not None else time.time()
            ),
            "base_monorepo_commit": "base-commit",
            "proposal_hash": "hash-1",
            "chains": [
                {
                    "chain": "ethereum",
                    "current_gas_amount": "10",
                    "proposed_gas_amount": "12",
                    "gas_decimals": 9,
                    "current_token_price": "3000",
                    "proposed_token_price": "3200",
                    "edited_by_user": False,
                    "is_sealevel": False,
                    "notes": "",
                }
            ],
            "review": {
                "confirmed": status in {"approved", "submitted", "failed", "aborted"},
                "confirmation_phrase_ok": status
                in {"approved", "submitted", "failed", "aborted"},
                "approved_at": "2026-01-01T00:00:00+00:00",
                "approved_version": approved_version,
                "final_diff_summary": "1 gas changes, 1 token price changes",
            },
            "submission": {
                "submission_idempotency_key": idempotency_key,
                "started_at": None,
                "completed_at": None,
                "command": None,
                "command_cwd": None,
                "exit_code": None,
                "stdout_log": None,
                "stderr_log": None,
                "result_artifacts": None,
                "dry_run": None,
                "status_reason": None,
                "backend": None,
                "disable_monorepo_min_usd_floor": None,
                "floor_patch_applied": None,
                "deploy_prompt_patch_applied": None,
                "monorepo_commit_at_submit": None,
                "base_monorepo_commit_mismatch": None,
                "preflight_warnings": [],
            },
        }
        proposal_path = self.proposals_dir / f"{proposal_id}.json"
        proposal_path.write_text(json.dumps(payload))
        return payload

    def _mock_subprocess_for_submit(self, command_codes: list[int]):
        outcomes = iter(command_codes)

        def _runner(cmd, capture_output=True, text=True, cwd=None):
            if (
                len(cmd) >= 5
                and cmd[0] == "git"
                and cmd[1] == "-C"
                and cmd[3] == "worktree"
                and "add" in cmd
            ):
                worktree_path = Path(cmd[6])
                (worktree_path / "typescript" / "infra").mkdir(parents=True, exist_ok=True)
                return subprocess.CompletedProcess(cmd, 0, "", "")
            if (
                len(cmd) >= 5
                and cmd[0] == "git"
                and cmd[1] == "-C"
                and cmd[3] == "worktree"
                and "remove" in cmd
            ):
                return subprocess.CompletedProcess(cmd, 0, "", "")
            if cmd and cmd[0] == "pnpm":
                code = next(outcomes)
                return subprocess.CompletedProcess(
                    cmd,
                    code,
                    "submit-ok" if code == 0 else "",
                    "" if code == 0 else "submit-failed",
                )
            raise AssertionError(f"Unexpected command: {cmd}")

        return _runner

    def test_validate_rejects_stale_proposal_without_force(self):
        proposal = self._write_proposal(base_scan_timestamp=time.time() - 7200)
        with patch.object(
            igp_submission, "_read_mainnet3_supported_chains", return_value={"ethereum"}
        ):
            result = igp_submission.validate_proposal(self.config, proposal, force=False)
        self.assertFalse(result["ok"])
        self.assertTrue(any("stale" in err.lower() for err in result["errors"]))

    def test_submit_blocks_on_circuit_breaker_without_force(self):
        self._write_proposal()
        with (
            patch.object(igp_submission, "validate_proposal", return_value={"ok": True, "errors": [], "warnings": []}),
            patch("engine.safety.SafetyChecker.check_circuit_breakers", return_value={"halt": True, "issues": ["breaker tripped"]}),
        ):
            with self.assertRaises(igp_submission.IGPSubmissionError):
                igp_submission.submit_proposal(
                    self.config,
                    "igp-test",
                    confirmation_phrase="APPLY IGP UPDATE",
                    dry_run=False,
                    force=False,
                )

    def test_submit_allows_circuit_breaker_with_force(self):
        self._write_proposal()
        with (
            patch.object(igp_submission, "validate_proposal", return_value={"ok": True, "errors": [], "warnings": []}),
            patch("engine.safety.SafetyChecker.check_circuit_breakers", return_value={"halt": True, "issues": ["breaker tripped"]}),
            patch.object(igp_submission, "_local_monorepo_commit", return_value="submit-commit"),
            patch.object(igp_submission, "_patch_worktree_json", return_value=(Path("x"), Path("y"))),
            patch.object(igp_submission, "_patch_igp_ts_disable_min_floor", return_value=True),
            patch.object(igp_submission, "_patch_deploy_ts_non_interactive", return_value=True),
            patch("engine.igp_submission.subprocess.run", side_effect=self._mock_subprocess_for_submit([0])),
        ):
            result = igp_submission.submit_proposal(
                self.config,
                "igp-test",
                confirmation_phrase="APPLY IGP UPDATE",
                dry_run=True,
                force=True,
            )
        self.assertEqual(result["status"], "aborted")
        warnings = result["submission"].get("preflight_warnings", [])
        self.assertTrue(any("override" in w.lower() for w in warnings))

    def test_dry_run_success_sets_aborted_not_submitted(self):
        self._write_proposal()
        with (
            patch.object(igp_submission, "validate_proposal", return_value={"ok": True, "errors": [], "warnings": []}),
            patch.object(igp_submission, "_check_submit_circuit_breaker", return_value=[]),
            patch.object(igp_submission, "_local_monorepo_commit", return_value="submit-commit"),
            patch.object(igp_submission, "_patch_worktree_json", return_value=(Path("x"), Path("y"))),
            patch.object(igp_submission, "_patch_igp_ts_disable_min_floor", return_value=True),
            patch.object(igp_submission, "_patch_deploy_ts_non_interactive", return_value=True),
            patch("engine.igp_submission.subprocess.run", side_effect=self._mock_subprocess_for_submit([0])),
        ):
            result = igp_submission.submit_proposal(
                self.config,
                "igp-test",
                confirmation_phrase="APPLY IGP UPDATE",
                dry_run=True,
                force=False,
            )
        self.assertEqual(result["status"], "aborted")
        self.assertEqual(result["status_reason"], "dry_run_aborted")

    def test_submit_success_sets_submitted(self):
        self._write_proposal()
        with (
            patch.object(igp_submission, "validate_proposal", return_value={"ok": True, "errors": [], "warnings": []}),
            patch.object(igp_submission, "_check_submit_circuit_breaker", return_value=[]),
            patch.object(igp_submission, "_local_monorepo_commit", return_value="submit-commit"),
            patch.object(igp_submission, "_patch_worktree_json", return_value=(Path("x"), Path("y"))),
            patch.object(igp_submission, "_patch_igp_ts_disable_min_floor", return_value=True),
            patch.object(igp_submission, "_patch_deploy_ts_non_interactive", return_value=True),
            patch("engine.igp_submission.subprocess.run", side_effect=self._mock_subprocess_for_submit([0])),
        ):
            result = igp_submission.submit_proposal(
                self.config,
                "igp-test",
                confirmation_phrase="APPLY IGP UPDATE",
                dry_run=False,
                force=False,
            )
        self.assertEqual(result["status"], "submitted")
        self.assertEqual(result["status_reason"], "submitted")
        self.assertEqual(result["submission"]["backend"], "deploy")
        self.assertTrue(result["submission"]["disable_monorepo_min_usd_floor"])
        self.assertTrue(result["submission"]["floor_patch_applied"])
        self.assertTrue(result["submission"]["deploy_prompt_patch_applied"])
        self.assertIn("scripts/deploy.ts", result["submission"]["command"])
        self.assertIn("--concurrentDeploy", result["submission"]["command"])

    def test_submit_failure_sets_failed_and_logs(self):
        self._write_proposal()
        with (
            patch.object(igp_submission, "validate_proposal", return_value={"ok": True, "errors": [], "warnings": []}),
            patch.object(igp_submission, "_check_submit_circuit_breaker", return_value=[]),
            patch.object(igp_submission, "_local_monorepo_commit", return_value="submit-commit"),
            patch.object(igp_submission, "_patch_worktree_json", return_value=(Path("x"), Path("y"))),
            patch.object(igp_submission, "_patch_igp_ts_disable_min_floor", return_value=True),
            patch.object(igp_submission, "_patch_deploy_ts_non_interactive", return_value=True),
            patch("engine.igp_submission.subprocess.run", side_effect=self._mock_subprocess_for_submit([1])),
        ):
            result = igp_submission.submit_proposal(
                self.config,
                "igp-test",
                confirmation_phrase="APPLY IGP UPDATE",
                dry_run=False,
                force=False,
            )
        self.assertEqual(result["status"], "failed")
        entries = igp_submission._load_jsonl(self.audit_log)
        self.assertEqual(entries[-1]["status"], "failed")

    def test_retry_allowed_after_failed_submit_same_key(self):
        self._write_proposal(idempotency_key="idem-retry")
        with (
            patch.object(igp_submission, "validate_proposal", return_value={"ok": True, "errors": [], "warnings": []}),
            patch.object(igp_submission, "_check_submit_circuit_breaker", return_value=[]),
            patch.object(igp_submission, "_local_monorepo_commit", return_value="submit-commit"),
            patch.object(igp_submission, "_patch_worktree_json", return_value=(Path("x"), Path("y"))),
            patch.object(igp_submission, "_patch_igp_ts_disable_min_floor", return_value=True),
            patch.object(igp_submission, "_patch_deploy_ts_non_interactive", return_value=True),
            patch("engine.igp_submission.subprocess.run", side_effect=self._mock_subprocess_for_submit([1, 0])),
        ):
            first = igp_submission.submit_proposal(
                self.config,
                "igp-test",
                confirmation_phrase="APPLY IGP UPDATE",
                dry_run=False,
                force=False,
            )
            second = igp_submission.submit_proposal(
                self.config,
                "igp-test",
                confirmation_phrase="APPLY IGP UPDATE",
                dry_run=False,
                force=False,
            )
        self.assertEqual(first["status"], "failed")
        self.assertEqual(second["status"], "submitted")

    def test_duplicate_blocked_after_successful_submit(self):
        self._write_proposal(idempotency_key="idem-success")
        self.audit_log.parent.mkdir(parents=True, exist_ok=True)
        with open(self.audit_log, "w") as f:
            f.write(
                json.dumps(
                    {
                        "proposal_id": "prior",
                        "submission_idempotency_key": "idem-success",
                        "status": "submitted",
                    }
                )
                + "\n"
            )
        with patch.object(
            igp_submission, "validate_proposal", return_value={"ok": True, "errors": [], "warnings": []}
        ):
            with self.assertRaises(igp_submission.IGPSubmissionError):
                igp_submission.submit_proposal(
                    self.config,
                    "igp-test",
                    confirmation_phrase="APPLY IGP UPDATE",
                    dry_run=False,
                    force=False,
                )

    def test_check_govern_backend_command(self):
        self._write_proposal()
        self.config["igp_submission"]["execution_backend"] = "check_govern"
        self.config["igp_submission"]["disable_monorepo_min_usd_floor"] = False
        with (
            patch.object(igp_submission, "validate_proposal", return_value={"ok": True, "errors": [], "warnings": []}),
            patch.object(igp_submission, "_check_submit_circuit_breaker", return_value=[]),
            patch.object(igp_submission, "_local_monorepo_commit", return_value="submit-commit"),
            patch.object(igp_submission, "_patch_worktree_json", return_value=(Path("x"), Path("y"))),
            patch.object(igp_submission, "_patch_igp_ts_disable_min_floor", return_value=False),
            patch.object(igp_submission, "_patch_deploy_ts_non_interactive", return_value=False),
            patch("engine.igp_submission.subprocess.run", side_effect=self._mock_subprocess_for_submit([0])),
        ):
            result = igp_submission.submit_proposal(
                self.config,
                "igp-test",
                confirmation_phrase="APPLY IGP UPDATE",
                dry_run=False,
                force=False,
            )
        self.assertEqual(result["status"], "submitted")
        self.assertEqual(result["submission"]["backend"], "check_govern")
        self.assertFalse(result["submission"]["disable_monorepo_min_usd_floor"])
        self.assertFalse(result["submission"]["floor_patch_applied"])
        self.assertIn("scripts/check/check-deploy.ts", result["submission"]["command"])
        self.assertIn("--govern", result["submission"]["command"])

    def test_patch_igp_ts_disable_min_floor_rewrites_boolean(self):
        igp_ts = self.monorepo / igp_submission.MAINNET3_IGP_TS_PATH
        igp_ts.parent.mkdir(parents=True, exist_ok=True)
        igp_ts.write_text(
            "const cfg = getAllStorageGasOracleConfigs(a, b, c, true, );\n"
        )
        applied = igp_submission._patch_igp_ts_disable_min_floor(
            self.monorepo,
            enabled=True,
        )
        self.assertTrue(applied)
        text = igp_ts.read_text()
        self.assertIn("false", text)

    def test_validate_runtime_artifacts_requires_core_for_deploy(self):
        # Stop the blanket setUp patch for this direct unit test.
        self.path_patchers[-1].stop()
        with self.assertRaises(igp_submission.IGPSubmissionError):
            igp_submission._validate_monorepo_runtime_artifacts(
                self.monorepo,
                "deploy",
            )
        # Restore patch for tearDown symmetry.
        self.path_patchers[-1].start()


if __name__ == "__main__":
    unittest.main()

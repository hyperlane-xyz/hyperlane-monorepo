#!/usr/bin/env python3
"""Pure retirement/event-membership guards; no role, network, or oracle execution."""
import gzip
import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "zig/integration"))
import relayer_process as process

spec = importlib.util.spec_from_file_location("relayer_benchmark_review", ROOT / "zig/bench/relayer.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class LiveProcess:
    @staticmethod
    def poll():
        return None


class RetirementTests(unittest.TestCase):
    def test_partial_early_retirement_fails_on_first_poll(self):
        partial = {"processed_count": 1, "queues": {"confirm": 2}}
        late_complete = {"processed_count": 3, "queues": {"confirm": 0}}
        coverage = {str(i): {"time_ns": 0} for i in range(3)}
        with mock.patch.object(bench, "settlement_metrics", side_effect=[partial, late_complete]) as sample, mock.patch.object(bench.time, "monotonic", side_effect=[0, 1, 601]) as clock, mock.patch.object(bench.time, "perf_counter_ns", return_value=1_000_000_000), mock.patch.object(bench.time, "sleep"):
            with self.assertRaisesRegex(AssertionError, "processed subset preceded"):
                bench.settle_live(0, LiveProcess(), 660, 0, 3, coverage)
        self.assertEqual(sample.call_count, 1)
        self.assertEqual(clock.call_count, 2)

    def test_staggered_eligible_retirement_and_final_completion(self):
        coverage = {"a": {"time_ns": 0}, "b": {"time_ns": 20_000_000_000}}
        samples = [{"processed_count": 1, "queues": {"confirm": 1}}, {"processed_count": 2, "queues": {"confirm": 0}}]
        with mock.patch.object(bench, "settlement_metrics", side_effect=samples), mock.patch.object(bench.time, "monotonic", side_effect=[0, 610, 621]), mock.patch.object(bench.time, "perf_counter_ns", side_effect=[610_000_000_000, 621_000_000_000]), mock.patch.object(bench.time, "sleep"):
            sample, timestamp = bench.settle_live(0, LiveProcess(), 660, 20_000_000_000, 2, coverage)
        self.assertEqual(timestamp, 621_000_000_000)
        self.assertEqual(sample["processed_count"], 2)

    def test_staggered_ineligible_second_retirement_rejected(self):
        coverage = {"a": {"time_ns": 0}, "b": {"time_ns": 20_000_000_000}}
        with mock.patch.object(bench, "settlement_metrics", return_value={"processed_count": 2, "queues": {"confirm": 1}}), mock.patch.object(bench.time, "monotonic", side_effect=[0, 610]), mock.patch.object(bench.time, "perf_counter_ns", return_value=610_000_000_000), mock.patch.object(bench.time, "sleep"):
            with self.assertRaisesRegex(AssertionError, "eligible_after_600s=1"):
                bench.settle_live(0, LiveProcess(), 660, 20_000_000_000, 2, coverage)

    def test_exact_inclusion_coverage_required(self):
        with self.assertRaisesRegex(ValueError, "one inclusion timestamp"):
            bench.settle_live(0, LiveProcess(), 660, 0, 3, {"a": {"time_ns": 0}})

    def test_process_restart_offset_and_partial_guards(self):
        messages = [{"id": "eligible", "included_monotonic": 0}, {"id": "remaining", "included_monotonic": 20}]
        with self.assertRaisesRegex(AssertionError, "partial early retirement"):
            process.retirement_poll([{"id": "remaining"}], 1, messages, 60)
        self.assertFalse(process.retirement_poll([{"id": "remaining"}], 5, messages, 610, historical_confirmed_offset=4))
        with self.assertRaisesRegex(AssertionError, "eligible_after600=1"):
            process.retirement_poll([{"id": "remaining"}], 6, messages, 610, historical_confirmed_offset=4)
        self.assertTrue(process.retirement_poll([], 6, messages, 620, historical_confirmed_offset=4))
        self.assertFalse(process.retirement_poll([], 0, messages, 620))

    def test_historical_allowance_cannot_hide_tracked_actor_disappearance(self):
        messages = [{"id": "new", "included_monotonic": 0}]
        with self.assertRaisesRegex(AssertionError, "disappeared before its own600s"):
            process.retirement_poll([{"id": "old"}], 4, messages, 60, historical_confirmed_offset=4)


class PerIdPresenceTests(unittest.TestCase):
    def test_native_guard_rejects_wrong_id_using_another_ids_eligibility(self):
        coverage = {"0xeligible-a": {"time_ns": 0}, "0xineligible-b": {"time_ns": 20_000_000_000}}
        samples = [{"processed_count": 1, "queues": {"confirm": 1}}, {"processed_count": 2, "queues": {"confirm": 0}}]
        with mock.patch.object(bench, "settlement_metrics", side_effect=samples) as sample, mock.patch.object(bench.time, "monotonic", side_effect=[0, 610, 621]), mock.patch.object(bench.time, "perf_counter_ns", side_effect=[610_000_000_000, 610_000_000_000, 621_000_000_000, 621_000_000_000]), mock.patch.object(bench.time, "sleep"):
            with self.assertRaisesRegex(AssertionError, "disappeared before its own600s"):
                bench.settle_live(0, LiveProcess(), 660, 20_000_000_000, 2, coverage, active_ids_fn=lambda: {"eligible-a"})
        self.assertEqual(sample.call_count, 1)

    def test_rust_cumulative_mode_is_explicitly_weaker(self):
        coverage = {"a": {"time_ns": 0}, "b": {"time_ns": 20_000_000_000}}
        samples = [{"processed_count": 1, "queues": {"confirm": 1}}, {"processed_count": 2, "queues": {"confirm": 0}}]
        with mock.patch.object(bench, "settlement_metrics", side_effect=samples), mock.patch.object(bench.time, "monotonic", side_effect=[0, 610, 621]), mock.patch.object(bench.time, "perf_counter_ns", side_effect=[610_000_000_000, 621_000_000_000]), mock.patch.object(bench.time, "sleep"):
            _, timestamp = bench.settle_live(0, LiveProcess(), 660, 20_000_000_000, 2, coverage)
        self.assertEqual(timestamp, 621_000_000_000)
        self.assertEqual(bench.retirement_evidence_capabilities(None)["per_id_active_presence_guard"], False)
        self.assertTrue(bench.retirement_evidence_capabilities(None)["cumulative_600s_bound"])
        self.assertIn("common cumulative counter bound only", bench.retirement_evidence_capabilities(None)["retirement_evidence_scope"])
        self.assertTrue(bench.retirement_evidence_capabilities(lambda: set())["per_id_active_presence_guard"])

    def test_native_guard_allows_genuine_eligible_retirement(self):
        coverage = {"a": {"time_ns": 0}, "b": {"time_ns": 20_000_000_000}}
        samples = [{"processed_count": 1, "queues": {"confirm": 1}}, {"processed_count": 2, "queues": {"confirm": 0}}]
        presence = mock.Mock(side_effect=[{"b"}, set()])
        with mock.patch.object(bench, "settlement_metrics", side_effect=samples), mock.patch.object(bench.time, "monotonic", side_effect=[0, 610, 621]), mock.patch.object(bench.time, "perf_counter_ns", side_effect=[610_000_000_000, 610_000_000_000, 621_000_000_000, 621_000_000_000]), mock.patch.object(bench.time, "sleep"):
            _, timestamp = bench.settle_live(0, LiveProcess(), 660, 20_000_000_000, 2, coverage, active_ids_fn=presence)
        self.assertEqual(timestamp, 621_000_000_000)
        self.assertEqual(presence.call_count, 2)

    def test_presence_fetches_actual_ids_from_both_destination_lists(self):
        def response(rows):
            value = mock.MagicMock()
            value.__enter__.return_value.read.return_value = json.dumps(rows).encode()
            return value
        with mock.patch.object(bench.urllib.request, "urlopen", side_effect=[response([{"id": "0xAB"}]), response([{"id": "0xcd"}])]) as request:
            self.assertEqual(bench.active_operation_ids(1234), {"ab", "cd"})
        self.assertEqual([call.args[0] for call in request.call_args_list], [f"http://127.0.0.1:1234/list_operations?destination_domain={bench.DESTINATION}", f"http://127.0.0.1:1234/list_operations?destination_domain={bench.DESTINATION_ALT}"])

    def test_missing_list_or_identity_never_fabricates_empty_presence(self):
        for rows in ({"unavailable": True}, [{"operation": {}}]):
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps(rows).encode()
            with mock.patch.object(bench.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "actual operation"):
                    bench.active_operation_ids(1234)

    def test_presence_without_id_coverage_rejected(self):
        with self.assertRaisesRegex(ValueError, "requires inclusion coverage"):
            bench.settle_live(0, LiveProcess(), 660, 0, 2, active_ids_fn=lambda: set())


    def test_presence_io_failure_cannot_hide_observed_early_counter(self):
        coverage = {"a": {"time_ns": 0}, "b": {"time_ns": 20_000_000_000}}
        presence = mock.Mock(side_effect=OSError("fixture admin read failed"))
        with mock.patch.object(bench, "settlement_metrics", return_value={"processed_count": 1, "queues": {"confirm": 1}}), mock.patch.object(bench.time, "monotonic", side_effect=[0, 1]), mock.patch.object(bench.time, "perf_counter_ns", return_value=1_000_000_000), mock.patch.object(bench.time, "sleep"):
            with self.assertRaisesRegex(AssertionError, "processed subset preceded"):
                bench.settle_live(0, LiveProcess(), 660, 20_000_000_000, 2, coverage, active_ids_fn=presence)
        presence.assert_not_called()


class MeasurementProfileTests(unittest.TestCase):
    def test_final_paired_profile_never_polls_operation_lists_for_either_role(self):
        with mock.patch.object(bench, "active_operation_ids") as read:
            for name in ("rust", "zig"):
                callback = bench.presence_callback("paired", name, 1234)
                self.assertIsNone(callback)
                self.assertFalse(bench.retirement_evidence_capabilities(callback)["per_id_active_presence_guard"])
                self.assertTrue(bench.retirement_evidence_capabilities(callback)["cumulative_600s_bound"])
        read.assert_not_called()

    def test_diagnostic_smoke_native_callback_and_capability_match_actual_polling(self):
        with mock.patch.object(bench, "active_operation_ids", return_value={"id"}) as read:
            self.assertIsNone(bench.presence_callback("smoke", "rust", 1234))
            callback = bench.presence_callback("smoke", "zig", 1234)
            self.assertTrue(bench.retirement_evidence_capabilities(callback)["per_id_active_presence_guard"])
            self.assertEqual(callback(), {"id"})
        read.assert_called_once_with(1234)

    @staticmethod
    def settlement(count):
        return {"production_confirm_seconds": 600, "expected_tracked_messages": count, "historical_confirmed_offset": 0, "historical_offset_is_upper_bound_not_injected_counter": True, "operations_confirmed": count, "first_live_completion": {"monotonic": 700, "confirmed": count}, "first_proxy_inclusions": [{"id_chunks": [f"{i + 1:064x}"], "first_positive_receipt_or_delivered_monotonic_seconds": 100} for i in range(count)]}

    def proofs(self, root, binary):
        digest = bench.digest(binary)
        values = {
            "relayer_process": {"passed": True, "binaries": {"relayer_sha256_chunks": digest}, "settlement": self.settlement(3), "max_batch_4": {"settlement": self.settlement(4), "actual_allocation": {"calls": 4, "members": [1, 2, 3, 4]}}, "preenqueue_crash": {"passed": True, "recovery_new_nonce_count": 1, "restart_new_nonce_count": 0, "settlement": self.settlement(1)}},
            "relayer_stream": {"passed": True, "executables": {"relayer_sha256_chunks": digest}, "case": {"passed": True, "restart": {"settlement": self.settlement(2)}}},
            "public_relay": {"passed": True, "binary_sha256_chunks": digest, "normal_indexed": {"passed": True, "settlement": self.settlement(2)}, "sole_sidecar": {"passed": True, "settlement": self.settlement(2)}},
        }
        paths = {}
        for kind, value in values.items():
            paths[kind] = root / f"{kind}.json"
            paths[kind].write_text(json.dumps(value))
        return paths

    def test_final_prerequisites_require_exact_pinned_binary_and_all_functional_cases(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-functional-proof-test-", dir="/tmp") as directory:
            root = pathlib.Path(directory)
            binary = root / "native"; binary.write_bytes(b"fixture exact binary; never executed")
            paths = self.proofs(root, binary)
            proof = bench.native_functional_prerequisites(paths, binary)
            self.assertTrue(proof["verified"])
            self.assertEqual(proof["native_sha256_chunks"], bench.digest(binary))
            self.assertEqual(proof["proofs"]["relayer_process"]["cases"], ["three_ISM", "maxBatch4", "preenqueue_crash"])
            self.assertEqual(proof["proofs"]["public_relay"]["cases"], ["normal_indexed", "sole_sidecar"])
            binary.write_bytes(b"different final binary")
            with self.assertRaisesRegex(RuntimeError, "differs from exact pinned"):
                bench.native_functional_prerequisites(paths, binary)

    def test_packed_functional_proofs_preserve_file_and_payload_provenance(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-packed-proof-test-", dir="/tmp") as directory:
            root = pathlib.Path(directory)
            binary = root / "native"; binary.write_bytes(b"fixture exact binary")
            paths = self.proofs(root, binary)
            payloads = {}
            for kind, path in paths.items():
                payloads[kind] = path.read_bytes()
                packed = path.with_suffix(".json.gz")
                packed.write_bytes(gzip.compress(payloads[kind], mtime=0))
                path.unlink()
                paths[kind] = packed
            proof = bench.native_functional_prerequisites(paths, binary)
            self.assertTrue(proof["verified"])
            for kind, path in paths.items():
                row = proof["proofs"][kind]
                self.assertEqual(row["encoding"], "gzip")
                self.assertEqual(row["sha256_chunks"], bench.digest(path))
                self.assertEqual(row["decoded_sha256_chunks"], bench.chunks(hashlib.sha256(payloads[kind]).hexdigest()))
            value = json.loads(payloads["public_relay"])
            value["sole_sidecar"]["passed"] = False
            paths["public_relay"].write_bytes(gzip.compress(json.dumps(value).encode(), mtime=0))
            with self.assertRaisesRegex(RuntimeError, "public sole_sidecar functional proof did not pass"):
                bench.native_functional_prerequisites(paths, binary)

    def test_corrupt_packed_functional_proof_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-corrupt-proof-test-", dir="/tmp") as directory:
            root = pathlib.Path(directory)
            binary = root / "native"; binary.write_bytes(b"fixture exact binary")
            paths = self.proofs(root, binary)
            path = root / "corrupt.json.gz"
            path.write_bytes(b"invalid gzip")
            paths["relayer_process"] = path
            with self.assertRaises(gzip.BadGzipFile):
                bench.native_functional_prerequisites(paths, binary)

    def test_final_prerequisites_reject_missing_failed_or_old_confirmation_evidence(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-functional-proof-test-", dir="/tmp") as directory:
            root = pathlib.Path(directory)
            binary = root / "native"; binary.write_bytes(b"fixture binary")
            with self.assertRaisesRegex(RuntimeError, "require --relayer-process-proof"):
                bench.native_functional_prerequisites({}, binary)
            paths = self.proofs(root, binary)
            process = json.loads(paths["relayer_process"].read_text())
            process["passed"] = False; paths["relayer_process"].write_text(json.dumps(process))
            with self.assertRaisesRegex(RuntimeError, "did not pass"):
                bench.native_functional_prerequisites(paths, binary)
            paths = self.proofs(root, binary)
            public = json.loads(paths["public_relay"].read_text())
            public["sole_sidecar"]["settlement"]["production_confirm_seconds"] = 5; paths["public_relay"].write_text(json.dumps(public))
            with self.assertRaisesRegex(RuntimeError, "lacks exact per-ID600s"):
                bench.native_functional_prerequisites(paths, binary)
            paths = self.proofs(root, binary)
            stream = json.loads(paths["relayer_stream"].read_text())
            stream["case"]["restart"]["settlement"]["first_live_completion"]["monotonic"] = 699; paths["relayer_stream"].write_text(json.dumps(stream))
            with self.assertRaisesRegex(RuntimeError, "precedes an included ID"):
                bench.native_functional_prerequisites(paths, binary)


    def test_isolated_functional_cases_cannot_use_historical_counter_allowances(self):
        settlement = self.settlement(3)
        settlement["historical_confirmed_offset"] = 4
        with self.assertRaisesRegex(RuntimeError, "isolated target IDs"):
            bench.require_functional_settlement(settlement, 3, "three-ISM")
        settlement["operations_confirmed"] = 7
        settlement["first_live_completion"]["confirmed"] = 7
        bench.require_functional_settlement(settlement, 3, "WSS explicit older IDs", allow_historical=True)


class EventMembershipTests(unittest.TestCase):
    def setUp(self):
        self.mailbox = "0x" + "44" * 20
        self.topic = "0x" + "aa" * 32
        self.identities = ["0x" + f"{i:02x}" * 32 for i in range(1, 5)]
        self.transaction = {"hash": "0x" + "11" * 32, "to": process.MULTICALL3, "from": process.evm.TEST_SIGNER, "input": "0xabcd"}
        self.receipt = {"status": "0x1", "transactionHash": self.transaction["hash"], "blockHash": "0x" + "22" * 32, "blockNumber": "0x10", "gasUsed": hex(400), "effectiveGasPrice": "0x2"}
        self.receipt["logs"] = [{"address": self.mailbox, "topics": [self.topic, identity], "transactionHash": self.receipt["transactionHash"], "blockHash": self.receipt["blockHash"], "blockNumber": self.receipt["blockNumber"]} for identity in self.identities]
        self.keccak = mock.patch.object(process.evm, "run", return_value=self.topic)
        self.keccak.start()
        self.addCleanup(self.keccak.stop)

    def test_successful_exact_event_set(self):
        proof = process.verify_process_events(self.receipt, self.mailbox, self.identities)
        self.assertEqual(proof["process_ids"], self.identities)

    def test_failed_receipt_rejected(self):
        self.receipt["status"] = "0x0"
        with self.assertRaisesRegex(AssertionError, "must succeed"):
            process.verify_process_events(self.receipt, self.mailbox, self.identities)

    def test_missing_event_rejected(self):
        self.receipt["logs"].pop()
        with self.assertRaisesRegex(AssertionError, "membership mismatch"):
            process.verify_process_events(self.receipt, self.mailbox, self.identities)

    def test_foreign_emitter_rejected(self):
        self.receipt["logs"][0]["address"] = "0x" + "55" * 20
        with self.assertRaisesRegex(AssertionError, "membership mismatch"):
            process.verify_process_events(self.receipt, self.mailbox, self.identities)

    def test_wrong_transaction_rejected(self):
        self.receipt["logs"][0]["transactionHash"] = "0x" + "66" * 32
        with self.assertRaisesRegex(AssertionError, "transaction identity"):
            process.verify_process_events(self.receipt, self.mailbox, self.identities)

    def test_duplicate_member_cannot_stand_in_for_missing_member(self):
        self.receipt["logs"][3] = self.receipt["logs"][0]
        with self.assertRaisesRegex(AssertionError, "membership mismatch"):
            process.verify_process_events(self.receipt, self.mailbox, self.identities)

    def batch_fixture(self):
        messages = [{"id": identity, "wire": f"{i:02x}" * 64} for i, identity in enumerate(self.identities, 1)]
        links = [{"message_id_chunks": process.chunks(message["id"][2:]), "estimated_gas": "100", "spent": {"gas_used": "100", "tokens_used": "200"}, "gas_expenditure_record_present": True, "message_source": "canonical", "canonical_nonce_message_present": True, "canonical_nonce_matches_message": True, "private_operation_stage": "delivered", "destination_payload_present": True} for message in messages]
        probe = {"sealed_payload_links": links, "messages": [{"spent": {"gas_used": "100", "tokens_used": "200"}} for _ in messages]}
        calls = [{"to": self.mailbox, "calldata": bytes.fromhex(message["wire"])} for message in messages]
        return messages, probe, calls

    def verify_batch(self, calls, messages, probe):
        with mock.patch.object(process, "canonical_receipt", return_value=(self.receipt, {"hash": self.receipt["blockHash"], "number": self.receipt["blockNumber"]})), mock.patch.object(process, "decode_aggregate3", return_value=calls), mock.patch.object(process, "process_wire", side_effect=lambda data: data), mock.patch.object(process, "original_estimate", return_value={"result": hex(100)}):
            return process.verify_batch_allocation(None, None, self.transaction, messages, probe, self.mailbox, messages)

    def test_four_distinct_batch_members_and_events(self):
        messages, probe, calls = self.batch_fixture()
        proof = self.verify_batch(calls, messages, probe)
        self.assertEqual(len(proof["members"]), 4)
        self.assertEqual(proof["truncation_remainder"], 0)

    def test_four_duplicate_calls_rejected_before_allocation(self):
        messages, probe, calls = self.batch_fixture()
        with self.assertRaisesRegex(AssertionError, "four distinct"):
            self.verify_batch([calls[0]] * 4, messages, probe)



class CatchupMeasurementTests(unittest.TestCase):
    def test_deliveries_before_readiness_still_include_full_interval(self):
        # Synthetic clocks, not an agent benchmark. The old denominator counted
        # all32 while excluding990ms of the1000ms actual launch interval.
        result = bench.catchup_measurements(32, 1_000_000_000, 1_990_000_000, 2_000_000_000)
        self.assertEqual(result['launch_to_caught_up_messages_per_second'], 32)
        self.assertEqual(result['launch_to_caught_up_ms'], 1000)
        self.assertEqual(result['post_readiness_catchup_ms'], 10)
        self.assertEqual(result['catchup_backlog_messages'], 32)
        self.assertNotIn('catchup_messages_per_second', result)

    def test_readiness_cannot_change_same_end_to_end_completion_rate(self):
        for ready in [1_000_000_000, 1_500_000_000, 2_000_000_000]:
            result = bench.catchup_measurements(7, 1_000_000_000, ready, 2_000_000_000)
            self.assertEqual(result['launch_to_caught_up_messages_per_second'], 7)
        result = bench.catchup_measurements(3, 0, 1, 100_000)
        self.assertEqual(result['launch_to_caught_up_messages_per_second'], 30000)
        self.assertEqual(result['launch_to_caught_up_ms'], .1)

    def test_invalid_count_or_clock_does_not_become_clamped_throughput(self):
        for args in [(0, 0, 1, 2), (True, 0, 1, 2), (1, 0, 0, 0), (1, 2, 1, 3), (1, 0, 3, 2), (1, -1, 0, 2), (1, 0, 1.0, 2), (1, False, 1, 2)]:
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                bench.catchup_measurements(*args)

    def test_pending_backlog_is_variable_unique_undelivered_and_exact_count(self):
        messages = [{'id': str(i)} for i in range(7)]
        queried = []
        self.assertEqual(bench.pending_backlog_count(messages, 7, lambda row: queried.append(row['id']) or False), 7)
        self.assertEqual(queried, [str(i) for i in range(7)])
        for rows, expected in [(messages, 6), ([{'id':'same'}, {'id':'same'}], 2), ([], 0), (messages, True)]:
            with self.subTest(expected=expected), self.assertRaises(RuntimeError):
                bench.pending_backlog_count(rows, expected, lambda row: False)
        with self.assertRaisesRegex(RuntimeError, 'already delivered'):
            bench.pending_backlog_count(messages, 7, lambda row: row['id']=='2')

    def test_pending_verification_failures_do_not_start_or_measure_agent(self):
        def broken(row): raise ValueError('fixture read failed')
        with self.assertRaisesRegex(ValueError, 'fixture read failed'):
            bench.pending_backlog_count([{'id':'one'}], 1, broken)
        with mock.patch.object(bench.time, 'perf_counter_ns', side_effect=AssertionError('measurement started')), mock.patch.object(bench.subprocess, 'Popen', side_effect=AssertionError('agent started')):
            self.assertEqual(bench.pending_backlog_count([{'id':'one'}], 1, lambda row:False), 1)

    def test_actual_measurement_consumers_and_prelaunch_query_scope(self):
        import ast
        source = pathlib.Path(bench.__file__).read_text()
        tree = ast.parse(source)
        attempt = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name=='run_attempt')
        calls = [n for n in ast.walk(attempt) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name)]
        pending = [n for n in calls if n.func.id=='pending_backlog_count']
        launches = [n for n in calls if n.func.id=='launch']
        self.assertEqual(len(pending),1)
        self.assertLess(pending[0].lineno, min(n.lineno for n in launches))
        self.assertEqual(ast.unparse(pending[0]), 'pending_backlog_count(messages, args.catchup, delivered)')
        self.assertIn('**catchup_measurements(backlog_count, daemon_start_ns, ready_ns, caught_ns)', source)
        self.assertIn('"direct_delivered_queries": backlog_count, "inside_relayer_timer": False', source)
        self.assertNotIn('"median_catchup_messages_per_second"', source)
        self.assertNotIn('row["catchup_messages_per_second"]', source)
        self.assertIn('"median_launch_to_caught_up_messages_per_second"', source)
        self.assertIn('"median_post_readiness_catchup_ms"', source)
        self.assertIn('"ms launch to backlog delivered"', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)

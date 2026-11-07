"""Owned correctness observer/controller; never used by timing harnesses.

The constructor has effects only when explicitly invoked after reviewed future
runtime/capacity approval. Importing this module starts no threads or network.
"""
from __future__ import annotations

import hashlib
import concurrent.futures
import errno
import http.client
import json
import os
import pathlib
import re
import socket
import threading
import time
import sys
import multivm_diagnostics

from multivm_evidence import starknet_unavailable_peers, checked_starknet_peer_context, ENDPOINT_FIELDS, RawTcpProxy, TransparentProxy, checked_artifact, direct_endpoint, direct_request, effective_config, endpoint_replacements, hex_bytes, process_identity, read_approval, require, rpc as direct_rpc, run_tool, urls, run_artifact, validate_evidence_nodes, selected_evidence_node, source_connect_url, verified_harness_identity, owned_devnet_name, verify_devnet_inspect
from multivm_evm import EvmEvidence, address, quantity, sql_delivery_query, sql_message_query, verify_canonical_rocks, verify_checkpoint_objects, verify_evm_accounting, verify_sql_message, log_metadata, validate_expenditure_expectations
from multivm_sql import sql_event_query
from multivm_tron import TronEvidence, tron_address

RESTART_CLOCK_SCOPE = 'One complete canonical/SDK/checkpoint/readiness proof BEFORE the first live anchor; then continuous actual child/config/authority/admin/no-resubmission and paired role-RPC checks; full canonical/SDK/SQL/checkpoint and stopped-reader proof again at final acceptance. No heavy proof is claimed per live sample.'
RESTART_DEADLINE_SCOPE = 'Python first after_restart entry+120s; not the earlier Rust caller Instant.'
RESTART_FINAL_SCOPE = 'Fresh final canonical/SDK/checkpoint/SQL and stopped-reader verification after live window and clean actual parent waits.'

OBSERVER_POLICY = {
    "version": "native-admin-observation-v2",
    "maximum_successful_domain_sample_gap_ns": 10_000_000_000,
    "maximum_GET_timeout_seconds": 2,
    "maximum_GET_attempts_per_domain": 8,
    "first_domain_anchor": "Earliest actual native first positive; never a fresh budget after a stall.",
    "retirement_observed_age_seconds": [600, 630],
    "qualification": "Coverage cap, not an API latency guarantee or exact deletion timestamp.",
}


def tron_transaction_id(value):
    """Hash actual protobuf raw_data (Transaction field1), not signed envelope."""
    raw = bytes.fromhex(value)
    cursor, raw_data = 0, None
    def varint():
        nonlocal cursor
        number = shift = 0
        while cursor < len(raw) and shift < 70:
            byte = raw[cursor]
            cursor += 1
            number |= (byte & 127) << shift
            if byte < 128:
                return number
            shift += 7
        raise ValueError("invalid signed Tron protobuf varint")
    while cursor < len(raw):
        tag = varint()
        require(tag & 7 == 2 and tag >> 3 in {1, 2}, "unexpected signed Tron envelope field")
        size = varint()
        require(size > 0 and cursor + size <= len(raw), "truncated signed Tron envelope")
        field = raw[cursor:cursor + size]
        cursor += size
        if tag >> 3 == 1:
            require(raw_data is None, "duplicate Tron raw_data")
            raw_data = field
        else:
            require(size == 65, "Tron signature width differs")
    require(raw_data is not None, "Tron raw_data absent")
    return "0x" + hashlib.sha256(raw_data).hexdigest()


def successful_json_rpc_exchange(request, response):
    """A successful response must belong to this exact physical request set."""
    batch = isinstance(request, list)
    requests = request if batch else [request]
    replies = response if batch and isinstance(response, list) else [response]
    if not requests or len(requests) > 1024 or len(replies) != len(requests) or batch != isinstance(response, list):
        return False
    def identity(value):
        return (type(value).__name__, value) if type(value) in (str, int) else None
    expected = []
    for row in requests:
        if not isinstance(row, dict) or row.get('jsonrpc') != '2.0' or not isinstance(row.get('method'), str) or identity(row.get('id')) is None:
            return False
        expected.append(identity(row['id']))
    if len(set(expected)) != len(expected):
        return False
    actual, success = [], False
    for row in replies:
        if not isinstance(row, dict) or row.get('jsonrpc') != '2.0' or identity(row.get('id')) is None or ('result' in row) == ('error' in row):
            return False
        actual.append(identity(row['id']))
        if 'error' in row:
            error = row['error']
            if not isinstance(error, dict) or type(error.get('code')) is not int or not isinstance(error.get('message'), str):
                return False
        else:
            success = True
    return len(set(actual)) == len(actual) and set(actual) == set(expected) and success


class RestartWindow:
    """Actual valid restarted-role observations, never a sleep or model credit."""
    minimum_ns = 30_000_000_000

    def __init__(self):
        self.epoch = None
        self.samples = []
        self.failed = False

    def invalidate(self):
        # Startup has no earned interval: retry ordinary incomplete readiness
        # within the caller's original120s budget. Once anchored, never reset.
        if self.samples:
            self.failed = True

    def observe(self, now_ns, epoch, activity, request_started):
        try:
            require(not self.failed, "restart observation window already failed")
            require(type(now_ns) is int and now_ns >= 0 and isinstance(epoch, str)
                    and re.fullmatch('[0-9a-f]{64}', epoch), "invalid restart clock/identity")
            require(isinstance(activity, dict) and activity and all(isinstance(k, str)
                    and type(v) is int and 0 < v <= now_ns for k, v in activity.items()),
                    "invalid actual restarted-role RPC clocks")
            require(isinstance(request_started, dict) and set(request_started) == set(activity)
                    and all(type(request_started[k]) is int and 0 < request_started[k] <= activity[k] for k in activity),
                    "actual paired successful request-start clocks required")
            fresh=all(now_ns-value<=OBSERVER_POLICY['maximum_successful_domain_sample_gap_ns']for value in activity.values())
            if not self.samples and not fresh:
                return False # Stale startup earns no anchor/elapsed time.
            require(fresh,'restarted successful RPC response older than10s')
            if self.epoch is None:
                self.epoch = epoch
            require(self.epoch == epoch, "restarted child/config identity changed during30s")
            if self.samples:
                previous = self.samples[-1]
                require(now_ns >= previous['observed_monotonic_ns'], "restart clock rollback")
                require(set(activity) == set(previous['role_rpc_activity']), "restarted role/chain set changed")
                require(now_ns - previous['observed_monotonic_ns'] <= OBSERVER_POLICY['maximum_successful_domain_sample_gap_ns'],
                        "restarted live observation gap exceeds10s")
                require(all(activity[k] >= previous['role_rpc_activity'][k] for k in activity),
                        "restarted RPC activity clock rollback")
                if not all(activity[k] > previous['role_rpc_activity'][k] and request_started[k] > previous['role_rpc_activity'][k] for k in activity):
                    return False # No fresh call from every role; no new clock credit.
            require(len(self.samples) < 2048, "bounded restart observation count")
            self.samples.append({'observed_monotonic_ns': now_ns, 'role_rpc_activity': dict(activity), 'role_rpc_request_started_ns': dict(request_started)})
            return now_ns - self.samples[0]['observed_monotonic_ns'] >= self.minimum_ns
        except Exception:
            self.failed = True
            raise

    def evidence(self):
        require(not self.failed and self.samples
                and self.samples[-1]['observed_monotonic_ns'] - self.samples[0]['observed_monotonic_ns'] >= self.minimum_ns,
                "actual continuous30s restarted-role proof incomplete")
        return {'schema': 1, 'minimum_live_ns': self.minimum_ns, 'epoch_sha256': self.epoch,
                'maximum_successful_sample_gap_ns': OBSERVER_POLICY['maximum_successful_domain_sample_gap_ns'],
                'samples': [dict(row, role_rpc_activity=dict(row['role_rpc_activity']), role_rpc_request_started_ns=dict(row['role_rpc_request_started_ns'])) for row in self.samples],
                'elapsed_live_ns': self.samples[-1]['observed_monotonic_ns'] - self.samples[0]['observed_monotonic_ns'],
                'clock_scope': 'Actual monotonic live samples; complete proof boundaries are explicit in schema2 Session evidence. Every accepted sample requires fresh physical RPC from each restarted role+chain.'}


class Lifecycle:
    """Per-ID observed native inclusion → live presence → actual retirement."""
    def __init__(self):
        self.first = {}
        self.rows = {}
        self.samples = 0
        self.last_sample_ns = None
        self.last_domain_samples = {}
        self.errors = []

    def included(self, message_id, transaction_hash, chain, now_ns):
        hex_bytes(message_id, 32)
        require(len(hex_bytes(transaction_hash)) in (32, 64), "full native transaction identity required")
        key = (chain, message_id.lower())
        old = self.first.get(key)
        candidate = {"id": message_id.lower(), "transaction_hash": transaction_hash.lower(), "chain": chain, "first_positive_monotonic_ns": now_ns}
        if old is not None and old["transaction_hash"] == "0x" + "00" * 32 and transaction_hash != old["transaction_hash"]:
            candidate["first_positive_monotonic_ns"] = min(now_ns, old["first_positive_monotonic_ns"])
            self.first[key] = candidate
            return
        if old is None or now_ns < old["first_positive_monotonic_ns"]:
            self.first[key] = candidate

    def sample_deadline(self, chains, now_ns):
        anchors = []
        for chain in chains:
            previous = self.last_domain_samples.get(chain)
            positives = [row["first_positive_monotonic_ns"] for key, row in self.first.items() if key[0] == chain]
            if previous is not None:
                anchors.append(previous)
            elif positives:
                anchors.append(min(positives))
        return (min(anchors) if anchors else now_ns) + OBSERVER_POLICY["maximum_successful_domain_sample_gap_ns"]

    def sample(self, operations, now_ns, *, domain_observations=None):
        require(type(now_ns) is int and now_ns >= 0, "invalid observer clock")
        require(self.last_sample_ns is None or now_ns >= self.last_sample_ns, "observer round clock rollback")
        require(isinstance(operations, dict) and operations, "actual observed domains missing")
        if domain_observations is None:
            domain_observations = {chain: {"request_started_monotonic_ns": now_ns, "response_received_monotonic_ns": now_ns} for chain in operations}
        require(isinstance(domain_observations, dict) and set(domain_observations) == set(operations), "domain observation coverage differs")
        gaps = {}
        for chain, observed in domain_observations.items():
            require(isinstance(observed, dict) and set(observed) == {"request_started_monotonic_ns", "response_received_monotonic_ns"}, "invalid domain observation schema")
            start, end = observed["request_started_monotonic_ns"], observed["response_received_monotonic_ns"]
            require(type(start) is int and type(end) is int and 0 <= start <= end <= now_ns, "invalid domain observation clock")
            previous = self.last_domain_samples.get(chain)
            positives = [row["first_positive_monotonic_ns"] for key, row in self.first.items() if key[0] == chain and row["first_positive_monotonic_ns"] <= end]
            anchor = previous if previous is not None else min(positives) if positives else end
            gap = end - anchor
            require(gap >= 0 and gap <= OBSERVER_POLICY["maximum_successful_domain_sample_gap_ns"], "per-domain observer clock rollback or sampling gap exceeds10s")
            gaps[chain] = gap
        self.last_sample_ns = now_ns
        self.last_domain_samples.update({chain: value["response_received_monotonic_ns"] for chain, value in domain_observations.items()})
        self.samples += 1
        seen = set()
        for chain, items in operations.items():
            observed = domain_observations[chain]
            observed_ns = observed["response_received_monotonic_ns"]
            require(isinstance(items, list), "actual active operations missing")
            for item in items:
                identity = item.get("id", "").lower()
                hex_bytes(identity, 32)
                key = (chain, identity)
                require(key not in seen, "duplicate active operation identity")
                seen.add(key)
                if key in self.first:
                    age = observed_ns - self.first[key]["first_positive_monotonic_ns"]
                    if age < 0:
                        continue # sample finished before a concurrent witness
                    operation = item.get("operation")
                    require(isinstance(operation, dict) and operation.get("type") == "PendingMessage", "active operation type differs")
                    row = self.rows.setdefault(key, {"early_active_samples": 0, "confirm_by_self_samples": 0, "retired_monotonic_ns": None})
                    message = operation.get("message")
                    require(isinstance(message, dict) and set(message) == {"version", "nonce", "origin", "sender", "destination", "recipient", "body"}, "actual admin message schema differs")
                    require(all(type(message[field]) is int for field in ("version", "nonce", "origin", "destination")) and isinstance(message["body"], list) and all(type(byte) is int and 0 <= byte <= 255 for byte in message["body"]), "actual admin message values differ")
                    message_hash = hashlib.sha256(json.dumps(message, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                    require(row.get("observed_message_sha256", message_hash) == message_hash, "tracked admin message changed under same ID")
                    row["observed_message_sha256"] = message_hash
                    row["last_present_request_started_ns"] = observed["request_started_monotonic_ns"]
                    row["last_present_response_received_ns"] = observed_ns
                    row["maximum_observed_sample_gap_ns"] = max(row.get("maximum_observed_sample_gap_ns", 0), gaps[chain])
                    require(row["retired_monotonic_ns"] is None, "retired tracked operation reappeared")
                    if age < 600_000_000_000:
                        row["early_active_samples"] += 1
                    if operation.get("status") == {"Confirm": "SubmittedBySelf"} and operation.get("submitted") is True:
                        row["confirm_by_self_samples"] += 1
                    require(age <= 630_000_000_000, "tracked operation did not retire within600+30s")
        for key, first in self.first.items():
            if key in seen or key[0] not in operations:
                continue
            observed = domain_observations[key[0]]
            observed_ns = observed["response_received_monotonic_ns"]
            age = observed_ns - first["first_positive_monotonic_ns"]
            if age < 0:
                continue
            require(age >= 600_000_000_000, "tracked operation disappeared before its own600s bound")
            row = self.rows.setdefault(key, {"early_active_samples": 0, "confirm_by_self_samples": 0, "retired_monotonic_ns": None})
            require(row["early_active_samples"] > 0 and row["confirm_by_self_samples"] > 0, "no actual early Confirm/SubmittedBySelf witness")
            if row["retired_monotonic_ns"] is None:
                require(age <= 630_000_000_000, "first actual retirement observed beyond600+30s")
                row["retired_monotonic_ns"] = observed_ns
                row["first_absent_request_started_ns"] = observed["request_started_monotonic_ns"]
                row["first_absent_response_received_ns"] = observed_ns
                row["maximum_observed_sample_gap_ns"] = max(row.get("maximum_observed_sample_gap_ns", 0), gaps[key[0]])

    def complete(self, identities):
        require(identities, "empty actual tracked delivery set")
        result = []
        for key in identities:
            require(key in self.first and key in self.rows, "actual per-ID lifecycle witness missing")
            row = self.rows[key]
            require(row["retired_monotonic_ns"] is not None, "tracked operation still active")
            result.append(dict(self.first[key], **row))
        return result


def admin_message_hash(wire):
    raw = hex_bytes(wire)
    require(len(raw) >= 77, "known native wire truncated")
    message = {"version": raw[0], "nonce": int.from_bytes(raw[1:5], "big"), "origin": int.from_bytes(raw[5:9], "big"), "sender": "0x" + raw[9:41].hex(), "destination": int.from_bytes(raw[41:45], "big"), "recipient": "0x" + raw[45:77].hex(), "body": list(raw[77:])}
    return hashlib.sha256(json.dumps(message, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def admin_operations(port, domain, *, timeout=1, connection_hook=None):
    require(type(port) is int and 0 < port <= 65535 and type(domain) is int and 0 <= domain < 2 ** 32, "invalid native admin endpoint")
    require(type(timeout) in (int, float) and 0 < timeout <= 2, "invalid bounded admin timeout")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        if connection_hook is not None:
            connection_hook(connection, True)
            connection.connect()
            connection_hook(connection, True)
        connection.request("GET", f"/list_operations?destination_domain={domain}")
        response = connection.getresponse()
        data = response.read(8 * 1024 * 1024 + 1)
        require(response.status == 200 and len(data) <= 8 * 1024 * 1024, "actual native admin sample failed")
        result = json.loads(data)
        require(isinstance(result, list), "native admin response is not operation list")
        return result
    finally:
        connection.close()
        if connection_hook is not None:
            connection_hook(connection, False)


def collect_admin_sample(port, chains, deadline_ns, diagnostic, stopped):
    """Parallel domains share one fixed coverage deadline; no retry renews it."""
    require(chains and type(deadline_ns) is int, "invalid admin sample deadline/domains")
    abort = threading.Event()
    connection_lock = threading.Lock()
    connections = {}

    def shutdown(sockets):
        for stream in sockets:
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError as error:
                if error.errno not in {errno.EBADF, errno.ENOTCONN, errno.EINVAL}:
                    raise

    def track(connection, present):
        with connection_lock:
            if present:
                streams = connections.setdefault(connection, set())
                if connection.sock is not None:
                    streams.add(connection.sock)
                if abort.is_set() or stopped():
                    shutdown(streams)
                    raise ValueError("admin sample stopped")
            else:
                connections.pop(connection, None)

    def read_domain(name, chain):
        domain = int(chain["domainid"])
        for attempt in range(1, OBSERVER_POLICY["maximum_GET_attempts_per_domain"] + 1):
            require(not stopped() and not abort.is_set(), "admin sample stopped")
            started = time.monotonic_ns()
            require(started < deadline_ns, "admin whole-sample deadline exceeded")
            timing = {"chain": name, "domain": domain, "port": port, "attempt": attempt, "request_started_monotonic_ns": started, "whole_sample_deadline_ns": deadline_ns}
            try:
                value = admin_operations(port, domain, timeout=min(2, (deadline_ns - started) / 1_000_000_000), connection_hook=track)
            except TimeoutError:
                ended = time.monotonic_ns()
                diagnostic(dict(timing, response_received_monotonic_ns=ended, outcome="transport_timeout"))
                require(ended < deadline_ns, "admin whole-sample deadline exceeded")
                continue
            except Exception as error:
                diagnostic(dict(timing, response_received_monotonic_ns=time.monotonic_ns(), outcome="hard_error", error_type=type(error).__name__))
                raise
            ended = time.monotonic_ns()
            diagnostic(dict(timing, response_received_monotonic_ns=ended, outcome="success", operation_count=len(value)))
            require(not stopped() and not abort.is_set(), "admin sample stopped")
            require(started <= ended <= deadline_ns, "admin whole-sample deadline exceeded or clock rolled back")
            return value, {"request_started_monotonic_ns": started, "response_received_monotonic_ns": ended}
        raise TimeoutError("bounded admin transport attempts exhausted")

    operations, observations = {}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(chains)), thread_name_prefix="native-admin-sample") as executor:
        futures = {executor.submit(read_domain, name, chain): name for name, chain in chains.items()}
        try:
            pending = set(futures)
            while pending:
                require(not stopped(), "admin sample stopped")
                remaining = (deadline_ns - time.monotonic_ns()) / 1_000_000_000
                require(remaining > 0, "admin whole-sample deadline exceeded")
                done, pending = concurrent.futures.wait(pending, timeout=min(0.05, remaining), return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    name = futures[future]
                    operations[name], observations[name] = future.result()
        finally:
            abort.set()
            with connection_lock:
                shutdown({stream for streams in connections.values() for stream in streams})
            for future in futures:
                future.cancel()
    require(set(operations) == set(chains), "actual admin domain sample incomplete")
    require(time.monotonic_ns() <= deadline_ns, "admin whole-sample deadline exceeded")
    return operations, observations


def validate_evm_case(manifest, case):
    require(type(case.get("schema")) is int and case["schema"] == 1 and case.get("scenario") == manifest["scenario"], "actual EVM/TRE case schema differs")
    names = case.get("chain_names")
    require(isinstance(names, list) and len(names) in (2, 3) and len(set(names)) == len(names) and all(isinstance(name, str) and re.fullmatch("[a-zA-Z0-9]+", name) for name in names), "reviewed Source selected chain names required")
    domains = case.get("domain_names")
    require(isinstance(domains, dict) and set(domains.values()) == set(names) and len(domains) == len(names), "reviewed Source domain/name map required")
    for domain in domains:
        require(isinstance(domain, str) and domain.isdigit() and str(int(domain)) == domain and 0 <= int(domain) < 2 ** 32, "invalid reviewed Source domain")
    corpus = case.get("initial_corpus")
    require(isinstance(corpus, dict) and set(corpus) == {"dispatches", "deliveries", "zero_insertions", "failed_body", "double_insertions"} and all(type(value) is int and value >= 0 for value in corpus.values()), "exact reviewed native corpus counts required")
    require(corpus["deliveries"] > 0 and corpus["dispatches"] == corpus["deliveries"] + corpus["zero_insertions"] + corpus["failed_body"] and corpus["double_insertions"] <= corpus["deliveries"], "reviewed Source corpus kinds inconsistent")
    require(case.get("payments_supported") is True, "Source EVM/TRE actual IGP evidence required")
    require(type(case.get("additional_refused_dispatches")) is int and case["additional_refused_dispatches"] == (1 if manifest["scenario"] == "evm" else 0), "actual Source restart/reorg corpus differs")
    require(isinstance(case.get("validator_addresses"), dict) and set(case["validator_addresses"]) == set(names), "reviewed public validator identities required")
    for value in case["validator_addresses"].values():
        address(value)
    require(isinstance(case.get("relayer_addresses"), dict) and set(case["relayer_addresses"]) == set(names), "reviewed public relayer signer identities required")
    if manifest["scenario"] == "tron":
        require(names == ["anvil1", "anvil2"] and domains == {"1212538670": "anvil1", "1212538671": "anvil2"}, "Source TRE selected names/domains differ")
        require(corpus == {"dispatches": 4, "deliveries": 4, "zero_insertions": 0, "failed_body": 0, "double_insertions": 0}, "Source TRE actual four-message corpus differs")
        require(all(address(value) == "0xc8599111f29c1e1e061265b4af93ea1f274ad78a" for value in case["validator_addresses"].values()), "Source TRE public checkpoint signer differs")
        require(all(tron_address(value) == "0xc8599111f29c1e1e061265b4af93ea1f274ad78a" for value in case["relayer_addresses"].values()), "Source TRE public relayer payer differs")
        require(isinstance(case.get("relayer_addresses"), dict) and set(case["relayer_addresses"]) == set(names), "reviewed native public signer identities required")
        for value in case["relayer_addresses"].values():
            tron_address(value)
    else:
        for value in case["relayer_addresses"].values():
            address(value)
        require(case.get("reorg_origin_chain") in names, "actual Source intentional reorg origin missing")


# Only the Source-explicit CW fallback exercise; never a global errno allowance.
def cw_expected_unavailable_definitions(manifest, case, approval):
    definition = case.get("expected_unavailable_endpoints")
    if definition is None:
        require("expected_unavailable_endpoints" not in approval, "unexpected unavailable endpoint approval")
        return ()
    require(manifest["scenario"] == case.get("scenario") == "cosmwasm", "unavailable endpoint scope is CW only")
    require(case.get("chain_names") == ["cosmostest99990", "cosmostest99991"] and case.get("domain_names") == {"99990":"cosmostest99990", "99991":"cosmostest99991"}, "CW Source domains differ")
    rows = [{"chain": name, "domain": domain, "field": "grpcurls", "ordinal": 0,
             "upstream": "http://localhost:1337", "healthy_fallback": f"http://127.0.0.1:{port}",
             "error_type": "ConnectionRefusedError", "phase": "upstream_connect"}
            for name, domain, port in [("cosmostest99990",99990,26603),("cosmostest99991",99991,26613)]]
    require(isinstance(definition, dict) and set(definition) == {"schema", "scenario", "endpoints"}
            and type(definition.get("schema")) is int and definition["schema"] == 1
            and definition.get("scenario") == "cosmwasm" and definition.get("endpoints") == rows
            and all(type(row.get("ordinal")) is int and type(row.get("domain")) is int for row in definition["endpoints"]),
            "only the exact Source-explicit CW unavailable peers are eligible")
    require(approval.get("expected_unavailable_endpoints") == definition, "unavailable peer approval differs")
    return tuple(dict(row) for row in rows)


def cw_expected_peer_context(definitions, manifest, chain_name, chain, role, field, ordinal, endpoint):
    if not definitions:
        return None
    matches = [row for row in definitions if row["chain"] == chain_name and row["field"] == field]
    if not matches:
        return None
    require(len(matches) == 1 and role in {"validator", "relayer", "scraper"}, "unexpected CW fallback consumer")
    row = matches[0]
    require(int(chain["domainid"]) == row["domain"] and urls(chain[field]) == [row["upstream"], row["healthy_fallback"]]
            and "customgrpcurls" not in chain, "captured Source CW fallback authority/order changed")
    if ordinal != row["ordinal"]:
        return None
    require(endpoint == row["upstream"], "captured unavailable peer differs")
    return dict(row, scenario="cosmwasm", role=role, case_inputs_sha256=manifest["case_inputs"]["sha256"])




def starknet_expected_unavailable_definitions(manifest,case,approval):
    key="expected_starknet_unavailable_endpoints";definition=case.get(key)
    if definition is None:
        require(key not in approval,"unexpected Starknet unavailable peer approval");return ()
    require(manifest["scenario"]==case.get("scenario")=="starknet" and approval.get("root_approved") is True,"Starknet-only approved unavailable peers required")
    require(case.get("chain_names")==["starknettest23448593","starknettest23448594"] and case.get("domain_names")=={"23448593":"starknettest23448593","23448594":"starknettest23448594"},"Source Starknet domains differ")
    expected={"schema":1,"scenario":"starknet","endpoints":starknet_unavailable_peers()}
    require(definition==expected and type(definition.get("schema")) is int and all(type(row.get("domain")) is int and type(row.get("ordinal")) is int for row in definition["endpoints"]),"exact Source Starknet fallback endpoints required")
    require(approval.get(key)==definition,"Starknet unavailable peer approval differs")
    return tuple(dict(row) for row in expected["endpoints"])


def starknet_expected_peer_context(definitions,manifest,name,chain,role,field,ordinal,endpoint):
    if not definitions or field!="rpcurls":return None
    require(manifest["scenario"]=="starknet" and role in {"validator","relayer","scraper"},"crossed Starknet fallback consumer")
    rows=[row for row in definitions if row["chain"]==name]
    require(len(rows)==3 and int(chain["domainid"])==rows[0]["domain"] and "customrpcurls" not in chain,"Source Starknet domain/field differs")
    expected=["http://127.0.0.1:1337","http://127.0.0.1:1338",rows[0]["healthy_fallback"],"http://127.0.0.1:1347"]
    require(urls(chain[field])==expected,"Source Starknet fallback order/authority changed")
    selected=[row for row in rows if row["ordinal"]==ordinal]
    if not selected:return None
    require(len(selected)==1 and endpoint==selected[0]["upstream"],"selected Starknet unavailable endpoint differs")
    return checked_starknet_peer_context(dict(selected[0],scenario="starknet",role=role,case_inputs_sha256=manifest["case_inputs"]["sha256"]),endpoint)


def restart_metrics_sample(port, deadline_ns, stopped):
    """One actual local GET with a whole deadline, including header trickle."""
    require(type(port) is int and 0 < port <= 65535, 'invalid restarted metrics port')
    abort = threading.Event()
    gate = threading.Lock()
    streams = set()
    def shutdown():
        with gate:
            for stream in streams:
                try: stream.shutdown(socket.SHUT_RDWR)
                except OSError as error:
                    if error.errno not in {errno.EBADF, errno.ENOTCONN, errno.EINVAL}: raise
    def read():
        started = time.monotonic_ns()
        remaining = (deadline_ns-started)/1_000_000_000
        require(remaining > 0 and not stopped(), 'restart metrics sample stopped/deadline')
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=min(1, remaining))
        try:
            connection.connect()
            with gate:
                if connection.sock is not None: streams.add(connection.sock)
                require(not abort.is_set() and not stopped(), 'restart metrics sample cancelled')
            connection.request('GET', '/metrics')
            response = connection.getresponse()
            body = response.read(8*1024*1024+1)
            ended = time.monotonic_ns()
            require(not abort.is_set() and not stopped() and started <= ended < deadline_ns, 'restart metrics sample exceeded original deadline')
            require(response.status == 200 and 0 < len(body) <= 8*1024*1024, 'restarted role metrics readiness failed')
            return {'port': port, 'request_started_monotonic_ns': started, 'response_received_monotonic_ns': ended,
                    'response_bytes': len(body), 'response_sha256': hashlib.sha256(body).hexdigest()}
        finally:
            connection.close()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='restart-metrics-read') as pool:
        future = pool.submit(read)
        try:
            while not future.done():
                require(not stopped() and time.monotonic_ns() < deadline_ns, 'restart metrics sample stopped/original deadline')
                concurrent.futures.wait([future], timeout=.05)
            require(not stopped() and time.monotonic_ns() < deadline_ns, 'restart metrics completion missed original whole deadline')
            return future.result()
        finally:
            abort.set()
            shutdown()
            future.cancel()


class Session:
    def __init__(self, manifest, owned_path, create_directory, adapter=None):
        self.manifest = manifest
        self.family = adapter
        self.approval = read_approval(manifest)
        self.case = json.loads(checked_artifact(manifest["case_inputs"]).read_text())
        self.expected_unavailable_definitions = cw_expected_unavailable_definitions(manifest, self.case, self.approval)
        self.expected_unavailable_notices = []
        self.starknet_unavailable_definitions=starknet_expected_unavailable_definitions(manifest,self.case,self.approval)
        self.starknet_unavailable_notices=[]
        self.starknet_healthy_rpc_fallbacks={}
        self.cw_healthy_grpc_fallbacks = {}
        require(self.case.get("schema") == 1 and self.case.get("scenario") == manifest["scenario"], "case scenario differs")
        require(adapter is not None or manifest["scenario"] in {"evm", "tron"}, "actual observer family unsupported")
        if adapter is not None:
            adapter.validate_case()
        else:
            validate_evm_case(manifest, self.case)
        self._owned_path = owned_path
        self.create_directory = create_directory
        self.evidence_relative = pathlib.Path(manifest["verifier"]["evidence_root"]).relative_to(manifest["task_root"])
        self.root = create_directory(manifest["task_root"], self.evidence_relative)
        self.evidence_nodes = validate_evidence_nodes(manifest, self.case)
        self.harness_parent = None
        self.devnets = {}
        if self.evidence_nodes:
            config = pathlib.Path(self.case["local_docker"]["config_dir"]).relative_to(manifest["task_root"])
            directory = create_directory(manifest["task_root"], config)
            require(not any(directory.iterdir()), "owned Docker config must be empty")
        self.lock = threading.RLock()
        self.captures = []
        self.proxies = []
        self.proxy_cache = {}
        self.failures = []
        self.transport_notices = []
        self.activity = {}
        self.successful_activity = {}
        self.diagnostic_first_activity = {}
        self.diagnostic_lock = threading.Lock()
        self.public_diagnostic_recorder = None
        self.broadcasts = []
        self.estimates = []
        self.self_transactions = set()
        self.receipt_membership = {}
        self.delivered_first = {}
        self.mailboxes = {}
        self.lifecycle = Lifecycle()
        self.initial = None
        self.restart = None
        self.before_restart = None
        self.after_restart = None
        self.restart_window = RestartWindow()
        self._init_restart_sampler()
        self.sampling_finished = False
        self.stop = threading.Event()
        crypto = EvmEvidence(manifest, "unused")
        self.process_topic = crypto.topic("ProcessId(bytes32)") if self.family is None else None
        self.delivered_selector = crypto.keccak("delivered(bytes32)")[:10] if self.family is None else None
        self.started_ns = time.monotonic_ns()
        self.sampler = threading.Thread(target=self._sample, name="owned-per-id-lifecycle-observer", daemon=True)
        self.sampler.start()

    def owned_path(self, relative):
        return self._owned_path(self.manifest["task_root"], relative)

    def tool(self, name, arguments, stdin=None, timeout=30):
        return run_tool(self.manifest, name, arguments, stdin=stdin, timeout=timeout)

    def family_tool(self, name, arguments, stdin=None, timeout=30):
        require(self.manifest["scenario"] == "radix" and name == "radix_reference" and arguments == ["evidence"] and 0 < timeout <= 30, "unreviewed family tool request")
        return run_artifact(self.manifest, self.case["family_tools"][name], arguments, stdin=stdin, timeout=timeout)

    def docker(self, arguments):
        config = self.case["local_docker"]
        directory = self.owned_path(pathlib.Path(config["config_dir"]).relative_to(self.manifest["task_root"]))
        require(directory.is_dir() and not any(directory.iterdir()), "owned Docker config changed")
        return self.tool("docker", ["--host", config["host"], "--config", str(directory), *arguments])

    def prepare_devnets(self, identity):
        identity = verified_harness_identity(self.manifest, self.approval, identity)
        if self.harness_parent is not None:
            require(self.harness_parent == identity, "harness ownership epoch changed")
            return
        # Called before the helper's first node side effect. No inspect/pull/run
        # is authorized here: empty list is a successful exact-name absence.
        for chain, node in self.evidence_nodes.items():
            name = owned_devnet_name(self.manifest["task_root"], identity["pid"], node["source_container_suffix"])
            require(self.docker(["container", "ls", "--all", "--no-trunc", "--filter", "name=^/" + name + "$", "--format", "{{.ID}}"] ) == "", "owned devnet name already exists")
            self.devnets[chain] = {"name": name, "absent_wall_ns": time.time_ns(), "absence_monotonic_ns": time.monotonic_ns(), "inspect": None}
            self.append("owned-devnet-absence.jsonl", dict(self.devnets[chain], chain=chain, harness_parent=identity))
        self.harness_parent = identity

    def verify_devnet(self, chain):
        require(self.harness_parent is not None and chain in self.devnets, "actual pre-node ownership receipt missing")
        verified_harness_identity(self.manifest, self.approval, self.harness_parent)
        proof = self.devnets[chain]
        rows = json.loads(self.docker(["inspect", "--type", "container", proof["name"]]))
        require(isinstance(rows, list) and len(rows) == 1, "exact owned container inspect missing")
        fixture = self.case["starknet_devnet"]
        require(self.approval.get("root_approved") is True and self.approval.get("scenario") == "starknet" and self.approval.get("starknet_devnet") == fixture, "exact approved Starknet container fixture required")
        labels = {"io.hyperlane.ziggy.case-root": hashlib.sha256(os.fsencode(pathlib.Path(self.manifest["task_root"]).resolve(strict=True))).hexdigest(), "io.hyperlane.ziggy.harness-pid": str(self.harness_parent["pid"]), "io.hyperlane.ziggy.run-token": fixture["run_token"]}
        require(self.evidence_nodes[chain]["image_id"] == fixture["image_id"], "approved devnet image differs from evidence endpoint")
        row = verify_devnet_inspect(rows[0], self.evidence_nodes[chain], proof["name"], proof["absent_wall_ns"], proof["inspect"], approved_image_id=fixture["image_id"], approved_labels=labels)
        if proof["inspect"] is None:
            proof["inspect"] = row
            self.append("owned-devnet-inspection.jsonl", {"chain": chain, "inspected_monotonic_ns": time.monotonic_ns(), "inspect": row})

    def keccak(self, value):
        result = self.tool("cast", ["keccak", value]).lower()
        hex_bytes(result, 32)
        return result

    def chain_config(self, name):
        candidates = [row["original"]["chains"][name] for row in self.captures if name in row["original"]["chains"]]
        require(candidates, "actual selected chain config missing")
        return candidates[-1]

    def rpc(self, chain, method, params):
        configured = self.chain_config(chain)
        if chain in self.evidence_nodes:
            endpoint = selected_evidence_node(configured, self.evidence_nodes[chain])
            self.verify_devnet(chain)
            self.append("direct-native-evidence-requests.jsonl", {"chain": chain, "method": method, "original_url": self.evidence_nodes[chain]["original_url"], "connect_url": endpoint, "container_id": self.devnets[chain]["inspect"]["Id"], "request_monotonic_ns": time.monotonic_ns(), "runtime_fallback_credit": False})
        else:
            endpoint = urls(configured.get("customrpcurls", configured["rpcurls"]))[0]
        return direct_rpc(endpoint, method, params)

    def native_http(self, endpoint, path, payload):
        return direct_request(endpoint, payload, path=path)

    def query_sql(self, chain, sql):
        import urllib.parse
        databases = [row["original"]["db"] for row in self.captures if row["original"]["role"] == "scraper" and chain in row["original"]["role_chain_names"]]
        require(databases and isinstance(databases[-1], str), "actual selected scraper DB missing")
        parsed = urllib.parse.urlsplit(databases[-1])
        require(parsed.scheme in {"postgres", "postgresql"} and parsed.hostname in {"localhost", "127.0.0.1", "::1"} and not parsed.query and not parsed.fragment, "nonfixture/overridden PostgreSQL URI")
        direct = "127.0.0.1" if parsed.hostname == "localhost" else parsed.hostname
        uri = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode({"hostaddr": direct})))
        return self.tool("psql", ["-X", "-A", "-t", "--no-password", "--dbname", uri, "-v", "ON_ERROR_STOP=1", "-c", sql])

    def record_broadcast(self, chain, identity, wire_digest, message_ids=None):
        require(len(hex_bytes(identity)) in (32, 64), "full native self-submission identity required")
        require(isinstance(wire_digest, str) and re.fullmatch("(?:0x)?[0-9a-f]{64}", wire_digest), "actual native wire digest missing")
        with self.lock:
            self.self_transactions.add((chain, identity.lower()))
            self.broadcasts.append({"chain": chain, "transaction_hash": identity.lower(), "monotonic_ns": time.monotonic_ns(), "raw_transaction_sha256": wire_digest, "message_ids": message_ids})

    def record_inclusion(self, chain, message_id, identity, ns, canonical_reference):
        require(isinstance(canonical_reference, dict) and canonical_reference, "actual native canonical receipt reference required")
        with self.lock:
            self.lifecycle.included(message_id, identity, chain, ns)
            self.append("native-inclusion-witnesses.jsonl", {"chain": chain, "id": message_id, "transaction_identity": identity, "first_positive_monotonic_ns": ns, "canonical_reference": canonical_reference})

    def append(self, filename, value):
        with self.lock:
            self._append_locked(filename, value)

    def _append_locked(self, filename, value):
        path = self.owned_path(self.evidence_relative / filename)
        with path.open("a") as stream:
            stream.write(json.dumps(value, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        self.owned_path(self.evidence_relative / filename)

    def failure(self, error):
        with self.lock:
            if isinstance(error, dict) and error.get("kind") == "peer_disconnect":
                self.transport_notices.append(error)
                self.append("native-peer-disconnects.jsonl", error)
                return
            if isinstance(error,dict) and error.get("kind")=="expected_starknet_rpc_endpoint_unavailable":
                context=error.get("context")
                require(isinstance(context,dict),"malformed Starknet unavailable peer notice")
                checked_starknet_peer_context(context,context.get("upstream"))
                require(self.manifest["scenario"]=="starknet" and context["case_inputs_sha256"]==self.manifest["case_inputs"]["sha256"] and error.get("positive_receipt_credit") is False and error.get("error_type")=="ConnectionRefusedError" and type(error.get("monotonic_ns")) is int and error["monotonic_ns"]>0 and any(context==dict(row,scenario="starknet",role=context["role"],case_inputs_sha256=self.manifest["case_inputs"]["sha256"]) for row in self.starknet_unavailable_definitions),"unapproved Starknet unavailable peer notice")
                self.starknet_unavailable_notices.append(error);self.transport_notices.append(error)
                self.append("native-starknet-unavailable-endpoints.jsonl",error);return
            if isinstance(error, dict) and error.get("kind") == "expected_source_endpoint_unavailable":
                context = error.get("context")
                require(isinstance(context, dict) and error.get("positive_receipt_credit") is False
                        and error.get("error_type") == "ConnectionRefusedError" and type(error.get("monotonic_ns")) is int,
                        "malformed unavailable endpoint notice")
                require(context.get("case_inputs_sha256") == self.manifest["case_inputs"]["sha256"]
                        and context.get("scenario") == "cosmwasm" and context.get("role") in {"validator","relayer","scraper"}
                        and any(context == dict(row,scenario="cosmwasm",role=context["role"],case_inputs_sha256=self.manifest["case_inputs"]["sha256"])
                                for row in self.expected_unavailable_definitions), "unapproved unavailable endpoint notice")
                self.expected_unavailable_notices.append(error)
                self.transport_notices.append(error)
                self.append("native-expected-unavailable-endpoints.jsonl", error)
                return
            self.failures.append(error)
            self.append("observer-errors.jsonl", {"monotonic_ns": time.monotonic_ns(), "error": error})
        token=self.diagnostic('transport')
        if token is not None:self.diagnostic('transport',token,'exception',sys.exc_info()[1])

    def capture(self, request):
        read_approval(self.manifest)
        capture = effective_config(request, self.manifest)
        if self.evidence_nodes:
            require(self.harness_parent is not None and capture["harness_pid"] == self.harness_parent["pid"], "capture lacks pre-node harness ownership")
            for chain in capture["chains"]:
                self.verify_devnet(chain)
        replacements = {}
        proxies = []
        try:
            for name, chain in capture["chains"].items():
                for field in sorted(ENDPOINT_FIELDS & chain.keys()):
                    replacements[(name, field)] = []
                    transport = self.family.transport(field) if self.family is not None else ("tcp" if "grpc" in field else "http-json")
                    require(transport in {"http-json", "tcp"}, "unimplemented endpoint transport")
                    for ordinal, endpoint in enumerate(urls(chain[field])):
                        def observe(req, result, status, now_ns, response, *, name=name, role=request["role"], field=field, endpoint=endpoint):
                            if req.get("transport") == "tcp":
                                self.append("opaque-native-streams.jsonl", {"chain": name, "role": role, "endpoint_field": field, "upstream": endpoint, "closed_monotonic_ns": now_ns, "streams": req, "positive_receipt_credit": False})
                            else:
                                self.observe(name, role, field, endpoint, req, result, status, now_ns, response)
                        # Preserve duplicate endpoint equivalence as well as
                        # fallback order/count; distinct proxy ports must not
                        # turn one configured URL into additional vote slots.
                        key = (request["role"], name, field, endpoint)
                        with self.lock:
                            proxy = self.proxy_cache.get(key)
                            if proxy is None:
                                if transport == "tcp" and self.manifest["scenario"] in {"cosmwasm", "cosmosnative"}:
                                    from multivm_h2 import Connection
                                    def h2_event(event, *, name=name, role=request["role"], field=field, endpoint=endpoint):
                                        with self.lock:
                                            record = dict(event, chain=name, role=role, endpoint_field=field, upstream=endpoint)
                                            self.append("native-grpc-observations.jsonl", record)
                                            self.family.observe(self, record)
                                            self.record_cw_grpc_recovery(record)
                                    expected_unavailable = cw_expected_peer_context(self.expected_unavailable_definitions,
                                        self.manifest,name,chain,request["role"],field,ordinal,endpoint)
                                    proxy = RawTcpProxy(endpoint, observe, self.failure,
                                        h2_observer_factory=lambda callback=h2_event: Connection(callback, self.failure),
                                        expected_unavailable=expected_unavailable)
                                else:
                                    connect = source_connect_url(endpoint, self.evidence_nodes.get(name))
                                    if self.manifest["scenario"]=="starknet" and transport!="tcp":
                                        context=starknet_expected_peer_context(self.starknet_unavailable_definitions,self.manifest,name,chain,request["role"],field,ordinal,endpoint)
                                        proxy=TransparentProxy(endpoint,observe,self.failure,connect_upstream=connect if connect!=endpoint else None,expected_starknet_unavailable=context)
                                    else:
                                        proxy = (RawTcpProxy if transport == "tcp" else TransparentProxy)(endpoint, observe, self.failure, connect_upstream=connect if connect != endpoint else None)
                                self.proxy_cache[key] = proxy
                                proxies.append(proxy)
                        replacements[(name, field)].append(proxy.endpoint)
            env, proxied = endpoint_replacements(capture, replacements)
            with self.lock:
                ordinal = len(self.captures)
                row = {"capture_ordinal": ordinal, "captured_monotonic_ns": time.monotonic_ns(), "original": capture, "proxied": proxied, "endpoint_environment": env}
                self.append("effective-role-configs.jsonl", row)
                self.captures.append(row)
                self.proxies.extend(proxies)
                if self.family is None:
                    for name, chain in capture["chains"].items():
                        self.mailboxes[name] = tron_address(chain["mailbox"]) if self.manifest["scenario"] == "tron" else address(chain["mailbox"])
            return {"schema": 1, "environment": env}
        except Exception:
            for proxy in proxies:
                proxy.close()
            raise

    def observe(self, chain, role, field, endpoint, request, result, status, now_ns, response):
        with self.lock:
            record = {"chain": chain, "role": role, "endpoint_field": field, "upstream": endpoint, "status": status, "requested_monotonic_ns": request["requested_monotonic_ns"], "received_monotonic_ns": now_ns, "request_wire_sha256": hashlib.sha256(request["wire"]).hexdigest(), "response_wire_sha256": hashlib.sha256(response["wire"]).hexdigest(), "request": request["json"], "response": result, "path": request["start"].split(" ")[1]}
            self.append("native-rpc-observations.jsonl", record)
            # Current JSON-RPC families require matched IDs and at least one
            # genuine result. Mixed valid success/error batches are activity;
            # all-error, foreign-ID and malformed responses are never credit.
            scenario = self.manifest.get('scenario')
            json_rpc = scenario in {'evm','cosmosnative','cosmwasm','starknet','sealevel','sealevel-composite'} or isinstance(request['json'], list) or isinstance(request['json'], dict) and ('jsonrpc' in request['json'] or 'method' in request['json'])
            success = status == 200 and (successful_json_rpc_exchange(request['json'], result) if json_rpc else scenario in {'radix','aleo','tron'} and (not isinstance(result, dict) or 'error' not in result))
            if success:
                start = request['requested_monotonic_ns']
                require(type(start) is int and type(now_ns) is int and 0 < start <= now_ns, 'invalid actual proxy request/response clocks')
                self.activity[(role, chain)] = now_ns
                if not hasattr(self, 'successful_activity'):
                    self.successful_activity = {}
                old = self.successful_activity.get((role, chain))
                if old is None or (start, now_ns) > (old['request_started_monotonic_ns'], old['response_received_monotonic_ns']):
                    self.successful_activity[(role, chain)] = {'request_started_monotonic_ns': start, 'response_received_monotonic_ns': now_ns}
                multivm_diagnostics.note_success(self,role,chain,start,now_ns)
            if self.family is not None:
                self.family.observe(self, record)
                self.record_starknet_rpc_recovery(record)
                return
            if status != 200:
                return
            requests = request["json"] if isinstance(request["json"], list) else [request["json"]]
            responses = result if isinstance(result, list) else [result]
            if field in {"rpcurls", "customrpcurls"}:
                by_id = {}
                for item in responses:
                    require(isinstance(item, dict) and "id" in item and item["id"] not in by_id, "RPC batch response identity differs")
                    by_id[item["id"]] = item
                require(len(requests) == len(responses), "RPC batch response count differs")
                for item in requests:
                    require(isinstance(item, dict) and item.get("id") in by_id, "RPC response ID missing")
                    answer = by_id[item["id"]]
                    if "error" in answer:
                        continue
                    self._jsonrpc(chain, role, item["method"], item.get("params", []), answer.get("result"), now_ns, request["requested_monotonic_ns"])
            else:
                self._wallet(chain, role, record["path"], request["json"], result, now_ns)

    def _jsonrpc(self, chain, role, method, params, result, now_ns, requested_ns):
        if method == "eth_estimateGas" and role == "relayer":
            self.estimates.append({"chain": chain, "params": params, "result": result, "requested_monotonic_ns": requested_ns, "received_monotonic_ns": now_ns})
        if method == "eth_sendRawTransaction" and role == "relayer" and isinstance(result, str):
            tx_hash = EvmEvidence(self.manifest, "unused").keccak(params[0])
            require(result.lower() == tx_hash, "actual broadcast raw bytes hash differs")
            self.self_transactions.add((chain, tx_hash))
            self.broadcasts.append({"chain": chain, "transaction_hash": tx_hash, "monotonic_ns": now_ns, "requested_monotonic_ns": requested_ns, "raw_transaction_sha256": hashlib.sha256(hex_bytes(params[0])).hexdigest()})
        if method == "eth_getTransactionReceipt" and isinstance(result, dict) and quantity(result.get("status")) == 1:
            tx_hash = params[0].lower()
            require(result.get("transactionHash", "").lower() == tx_hash, "observed native receipt identity differs")
            ids = []
            for log in result.get("logs", []):
                if address(log["address"]) == self.mailboxes[chain] and len(log.get("topics", [])) == 2 and log["topics"][0].lower() == self.process_topic:
                    ids.append(log["topics"][1].lower())
            if ids:
                self.receipt_membership[(chain, tx_hash)] = ids
                if (chain, tx_hash) in self.self_transactions:
                    for identity in ids:
                        self.lifecycle.included(identity, tx_hash, chain, min(now_ns, self.delivered_first.get((chain, identity), now_ns)))
        # delivered=true is an independent earlier witness for a message whose
        # exact self-submitted receipt is already known. Unknown cases are kept
        # in the raw trace, never promoted into a guessed transaction mapping.
        if method == "eth_call" and params and isinstance(params[0], dict) and isinstance(result, str):
            data = params[0].get("data", "").lower()
            if address(params[0]["to"]) == self.mailboxes[chain] and data.startswith(self.delivered_selector) and len(data) == 74 and int.from_bytes(hex_bytes(result, 32), "big") == 1:
                identity = "0x" + data[10:]
                self.delivered_first.setdefault((chain, identity), now_ns)
                # Track presence immediately, even when delivered=true precedes
                # the first ProcessId receipt. Final acceptance must later bind
                # this provisional witness to exact self-submitted canonical tx.
                self.lifecycle.included(identity, "0x" + "00" * 32, chain, now_ns)
                for (known_chain, tx_hash), ids in self.receipt_membership.items():
                    if known_chain == chain and identity in ids and (chain, tx_hash) in self.self_transactions:
                        self.lifecycle.included(identity, tx_hash, chain, now_ns)

    def _wallet(self, chain, role, path, request, result, now_ns):
        if role == "relayer" and path.endswith("/broadcasthex") and isinstance(result, dict) and result.get("result") is True:
            tx_hash = tron_transaction_id(request["transaction"])
            self.self_transactions.add((chain, tx_hash))
            self.broadcasts.append({"chain": chain, "transaction_hash": tx_hash, "monotonic_ns": now_ns, "raw_transaction_sha256": hashlib.sha256(bytes.fromhex(request["transaction"])).hexdigest()})
        if path.endswith("/gettransactioninfobyid") and isinstance(result, dict) and result.get("id"):
            tx_hash = "0x" + result["id"].lower()
            require(tx_hash == "0x" + request["value"].removeprefix("0x").lower(), "observed native TRE receipt identity differs")
            for log in result.get("log", []):
                topics = log.get("topics", [])
                if tron_address(log["address"]) == self.mailboxes[chain] and len(topics) == 2 and "0x" + topics[0].removeprefix("0x").lower() == self.process_topic and (chain, tx_hash) in self.self_transactions:
                    self.lifecycle.included("0x" + topics[1].removeprefix("0x").lower(), tx_hash, chain, now_ns)

    def _sample(self):
        while not self.stop.wait(0.2):
            with self.lock:
                relayers = [row for row in self.captures if row["original"]["role"] == "relayer"]
                if not relayers or not self.lifecycle.first or self.sampling_finished:
                    continue
                latest = relayers[-1]["original"]
                chains = dict(latest["chains"])
                deadline = self.lifecycle.sample_deadline(chains, time.monotonic_ns())
            try:
                operations, observed = collect_admin_sample(latest["metrics_port"], chains, deadline, lambda row: self.append("admin-sampling-diagnostics.jsonl", row), self.stop.is_set)
                with self.lock:
                    now = time.monotonic_ns()
                    require(now <= deadline, "admin whole-sample deadline exceeded")
                    self.lifecycle.sample(operations, now, domain_observations=observed)
                    self.append("active-operation-samples.jsonl", {"monotonic_ns": now, "operations": operations, "domain_observations": observed, "observer_policy": OBSERVER_POLICY})
            except Exception as error:
                if not self.stop.is_set():
                    token=self.diagnostic('sampler')
                    if token is not None:self.diagnostic('sampler',token,'exception',error)
                    self.failure(type(error).__name__ + ": " + str(error))
                return # A hard coverage/schema failure is latched; no later re-credit.

    def adapter(self, chain):
        def effective(base, custom):
            return urls(chain[custom] if custom in chain else chain[base])[0]
        endpoint = effective("rpcurls", "customrpcurls")
        if self.manifest["scenario"] == "tron":
            return TronEvidence(self.manifest, endpoint, effective("walleturls", "customwalleturls"), effective("walletsolidityurls", "customwalletsolidityurls"))
        return EvmEvidence(self.manifest, endpoint, reorg_depth=chain.get("blocks", {}).get("reorgperiod", 0))

    def record_cw_grpc_recovery(self, record):
        # Called only AFTER the existing strict H2 and family observer accept it.
        status = record.get("response", {}).get("trailers", {}).get("grpc-status",
                     record.get("response", {}).get("headers", {}).get("grpc-status"))
        if record.get("status") != 200 or status != "0":
            return
        if not any(record["chain"] == row["chain"] and record["endpoint_field"] == row["field"]
                   and record["upstream"] == row["healthy_fallback"] for row in self.expected_unavailable_definitions):
            return
        received = record["received_monotonic_ns"]
        require(type(received) is int and received > 0, "invalid healthy fallback receive clock")
        key = (record["role"],record["chain"],record["endpoint_field"],record["upstream"])
        with self.lock:
            self.cw_healthy_grpc_fallbacks[key] = max(received, self.cw_healthy_grpc_fallbacks.get(key, 0))

    def record_starknet_rpc_recovery(self,record):
        definitions=getattr(self,"starknet_unavailable_definitions",())
        if not definitions or record.get("status")!=200:return
        if not any(record.get("chain")==row["chain"] and record.get("endpoint_field")==row["field"] and record.get("upstream")==row["healthy_fallback"] for row in definitions):return
        # Called AFTER the unchanged family observer accepts the parsed wire.
        request,response=record.get("request"),record.get("response")
        if not isinstance(request,dict) or not isinstance(response,dict) or response.get("jsonrpc")!="2.0" or request.get("jsonrpc")!="2.0" or "error" in response or "result" not in response:return
        if type(request.get("id")) not in (int,str) or type(response.get("id")) is not type(request["id"]) or response["id"]!=request["id"] or not isinstance(request.get("method"),str) or not request["method"].startswith("starknet_"):return
        received=record["received_monotonic_ns"];require(type(received) is int and received>0,"actual Starknet healthy fallback receive clock required")
        key=(record["role"],record["chain"],record["endpoint_field"],record["upstream"])
        self.starknet_healthy_rpc_fallbacks[key]=max(received,self.starknet_healthy_rpc_fallbacks.get(key,0))

    def require_starknet_peer_recovery(self):
        with self.lock:
            for notice in getattr(self,"starknet_unavailable_notices",()):
                row=notice["context"]
                captures=[capture for capture in self.captures if capture["original"]["role"]==row["role"] and row["chain"] in capture["original"]["role_chain_names"] and row["chain"] in capture["original"]["chains"]]
                require(captures,"Source Starknet unavailable peer has no selected consumer capture")
                captured=max(capture["captured_monotonic_ns"] for capture in captures)
                require(type(captured) is int and captured>0,"actual Starknet consumer capture clock required")
                received=self.starknet_healthy_rpc_fallbacks.get((row["role"],row["chain"],row["field"],row["healthy_fallback"]))
                require(type(received) is int and received>=max(captured,notice["monotonic_ns"]),"Source Starknet unavailable peer has no fresh actual healthy fallback")

    def require_expected_peer_recovery(self):
        # Proxy URLs/cache keys intentionally survive restart. Recovery may not
        # reuse a success predating the latest selected role+chain capture.
        with self.lock:
            for notice in self.expected_unavailable_notices:
                row = notice["context"]
                captures = [capture for capture in self.captures
                            if capture["original"]["role"] == row["role"]
                            and row["chain"] in capture["original"]["role_chain_names"]
                            and row["chain"] in capture["original"]["chains"]]
                require(captures, "Source unavailable peer has no selected consumer capture")
                captured = max(capture["captured_monotonic_ns"] for capture in captures)
                require(type(captured) is int and captured > 0, "invalid selected consumer capture clock")
                received = self.cw_healthy_grpc_fallbacks.get((row["role"],row["chain"],row["field"],row["healthy_fallback"]))
                require(type(received) is int and received >= captured,
                        "Source unavailable peer had no fresh healthy fallback for latest capture")

    def canonical_snapshot(self, expected, *, initial, phase=None):
        if self.family is not None:
            self.require_expected_peer_recovery()
            self.require_starknet_peer_recovery()
            snapshot = self.family.collect(self, expected, phase or ("initial" if initial else "final"))
            require(isinstance(snapshot, dict) and isinstance(snapshot.get("messages"), list) and isinstance(snapshot.get("deliverable_messages"), list) and isinstance(snapshot.get("native_delivery_transactions"), list), "actual native family snapshot missing")
            messages = {row["id"]: row for row in snapshot["messages"]}
            require(len(messages) == len(snapshot["messages"]), "duplicate actual native dispatch ID")
            deliverable = snapshot["deliverable_messages"]
            require(len(deliverable) == expected and len({row["id"] for row in deliverable}) == expected, "actual family eligible delivery coverage differs")
            for message in deliverable:
                require(message["id"] in messages and message["wire"] == messages[message["id"]]["wire"], "family delivery differs from actual dispatch wire")
                require((message["delivery_chain"], message["delivery_transaction"]) in self.self_transactions, "actual family delivery not self-submitted")
            lifecycle = self.lifecycle.complete([(message["delivery_chain"], message["id"]) for message in deliverable])
            for row in lifecycle:
                message = next(item for item in deliverable if item["id"] == row["id"])
                require(row["transaction_hash"] == message["delivery_transaction"], "native family first inclusion differs from canonical delivery")
                require(row["observed_message_sha256"] == admin_message_hash(message["wire"]), "actual early native operation differs from exact known dispatch wire")
            memberships = {}
            for transaction in snapshot["native_delivery_transactions"]:
                key = (transaction["chain"], transaction["transaction_hash"])
                require(key not in memberships, "duplicate native shared transaction")
                memberships[key] = transaction["proof"]["message_ids"]
            for key, ids in memberships.items():
                expected_ids = {message["id"] for message in deliverable if (message["delivery_chain"], message["delivery_transaction"]) == key}
                require(len(ids) == len(set(ids)) and set(ids) == expected_ids, "actual shared native receipt membership differs")
            require(set(memberships) == {(message["delivery_chain"], message["delivery_transaction"]) for message in deliverable}, "native canonical transaction proof coverage missing")
            relayers = [row for row in self.captures if row["original"]["role"] == "relayer"]
            snapshot.update({"runtime_source_commit": self.manifest["runtime_source_commit"], "scenario": self.manifest["scenario"], "per_id_lifecycle": lifecycle, "observer_policy": dict(OBSERVER_POLICY), "broadcasts": list(self.broadcasts), "capture_count": len(self.captures), "relayer_capture_ordinal": relayers[-1]["capture_ordinal"]})
            self.require_expected_peer_recovery()
            self.require_starknet_peer_recovery()
            require(not self.failures, "native observer failed during family canonical verification")
            return snapshot
        with self.lock:
            require(not self.failures, "native observer failed: " + "; ".join(self.failures))
            relayers = [row for row in self.captures if row["original"]["role"] == "relayer"]
            require(relayers, "actual relayer capture absent")
            original = relayers[-1]["original"]
            chain_map = original["chains"]
        require(set(chain_map) == set(self.case["chain_names"]), "actual deployed chain set differs")
        domains = {int(chain["domainid"]): name for name, chain in chain_map.items()}
        require(len(domains) == len(chain_map), "duplicate actual domain")
        require(domains == {int(domain): name for domain, name in self.case["domain_names"].items()}, "actual configured domains differ from reviewed fixture")
        adapters = {name: self.adapter(chain) for name, chain in chain_map.items()}
        messages = [message for name, chain in chain_map.items() for message in adapters[name].dispatches(chain)]
        ids = {message["id"] for message in messages}
        require(len(ids) == len(messages), "duplicate actual native message ID")
        corpus = self.case["initial_corpus"]
        require(type(expected) is int and expected == corpus["deliveries"], "Rust expected count differs from actual reviewed workload")
        require(len(messages) == corpus["dispatches"] + (0 if initial else self.case["additional_refused_dispatches"]), "actual native dispatch corpus count differs")
        excluded_failure = [message for message in messages if message["body"] == "0x" + b"failMessageBody".hex()]
        excluded_zero = [message for message in messages if not message["insertions"]]
        double = [message for message in messages if len(message["insertions"]) == 2]
        require(len(excluded_failure) == corpus["failed_body"] and len(excluded_zero) == corpus["zero_insertions"] and len(double) == corpus["double_insertions"], "actual receipt-derived workload kinds differ")
        require(all(len(message["insertions"]) <= 2 for message in messages), "unexpected insertion multiplicity")
        if initial:
            deliverable = [message for message in messages if message not in excluded_failure and message not in excluded_zero]
        else:
            require(self.initial is not None, "initial native corpus has not passed")
            expected_ids = {message["id"] for message in self.initial["deliverable_messages"]}
            deliverable = [message for message in messages if message["id"] in expected_ids]
            prior_ids = {message["id"] for message in self.initial["messages"]}
            for message in messages:
                if message["id"] not in prior_ids:
                    require(message["origin_chain"] == self.case["reorg_origin_chain"], "unexpected additional actual dispatch")
        require(len(deliverable) == expected, "actual eligible native delivery count differs")
        transactions, delivered_ids = {}, set()
        for message in messages:
            name = domains.get(message["destination"])
            require(name is not None, "actual dispatch destination outside selected fixture")
            delivered = adapters[name].delivered(chain_map[name]["mailbox"], message["id"])
            require(delivered is (message in deliverable), "actual native delivered state differs from eligible corpus")
            if not delivered:
                continue
            process_topic = adapters[name].topic("ProcessId(bytes32)")
            mailbox = tron_address(chain_map[name]["mailbox"]) if self.manifest["scenario"] == "tron" else address(chain_map[name]["mailbox"])
            logs = adapters[name].call("eth_getLogs", [{"address": mailbox, "fromBlock": "0x0", "toBlock": "latest", "topics": [process_topic, message["id"]]}])
            require(isinstance(logs, list) and len(logs) == 1, "actual canonical delivery log missing/duplicate")
            transaction_hash = logs[0]["transactionHash"].lower()
            require((name, transaction_hash) in self.self_transactions, "delivery was not submitted by the actual relayer through intercepted endpoint")
            key = (name, transaction_hash)
            if key not in transactions:
                transactions[key] = adapters[name].canonical_receipt(transaction_hash, mailbox=mailbox)
            proof = transactions[key]
            require(message["id"] in proof["message_ids"], "native mailbox ProcessId absent from canonical receipt")
            canonical_logs = [log for log in proof["receipt"]["logs"] if address(log["address"]) == mailbox and [topic.lower() for topic in log["topics"]] == [process_topic, message["id"]]]
            require(len(canonical_logs) == 1 and canonical_logs[0] == logs[0], "delivery range row differs from canonical receipt")
            message["event_metadata"]["delivery"] = [log_metadata(name, int(chain_map[name]["domainid"]), canonical_logs[0])]
            message["delivery_chain"] = name
            message["delivery_transaction"] = transaction_hash
            delivered_ids.add(message["id"])
        with self.lock:
            lifecycle = self.lifecycle.complete([(message["delivery_chain"], message["id"]) for message in deliverable])
            for row in lifecycle:
                message = next(item for item in deliverable if item["id"] == row["id"])
                require(row["transaction_hash"] == message["delivery_transaction"], "first observed inclusion is not the actual canonical delivery transaction")
                require(row["observed_message_sha256"] == admin_message_hash(message["wire"]), "actual early operation differs from exact known dispatch wire")
            broadcasts = list(self.broadcasts)
        require(not self.failures, "native observer failed during canonical verification")
        return {"runtime_source_commit": self.manifest["runtime_source_commit"], "scenario": self.manifest["scenario"], "messages": messages, "deliverable_messages": deliverable, "native_delivery_transactions": [{"chain": chain, "transaction_hash": tx, "proof": proof} for (chain, tx), proof in transactions.items()], "per_id_lifecycle": lifecycle, "observer_policy": dict(OBSERVER_POLICY), "broadcasts": broadcasts, "capture_count": len(self.captures), "relayer_capture_ordinal": relayers[-1]["capture_ordinal"]}

    def checkpoint_proofs(self, snapshot):
        if self.family is not None:
            return self.family.checkpoints(self, snapshot)
        messages = snapshot["messages"]
        require(isinstance(self.case.get("validator_addresses"), dict), "reviewed public validator identities required")
        result = []
        for capture in self.captures:
            original, proxied = capture["original"], capture["proxied"]
            if original["role"] != "validator":
                continue
            require(len(original["role_chain_names"]) == 1, "actual validator origin differs")
            name = original["role_chain_names"][0]
            checkpoint = original["checkpoint_syncer"]
            require(isinstance(checkpoint, dict) and checkpoint.get("type") == "localStorage" and isinstance(checkpoint.get("path"), str), "actual local checkpoint path missing")
            path = pathlib.Path(checkpoint["path"])
            relative = path.relative_to(self.manifest["task_root"])
            path = self.owned_path(relative)
            chain = original["chains"][name]
            if self.manifest["scenario"] == "tron":
                chain = dict(chain, merkletreehook=tron_address(chain["merkletreehook"]))
            selected_rpc = proxied["chains"][name]
            rpc_urls = []
            for base, custom in [("rpcurls", "customrpcurls"), ("grpcurls", "customgrpcurls"), ("walleturls", "customwalleturls"), ("walletsolidityurls", "customwalletsolidityurls")]:
                if custom in selected_rpc or base in selected_rpc:
                    rpc_urls.extend(urls(selected_rpc[custom] if custom in selected_rpc else selected_rpc[base]))
            proof = verify_checkpoint_objects(path, chain, self.case["validator_addresses"][name], [message for message in messages if message["origin_chain"] == name], self.adapter(chain).keccak, git_sha=self.manifest["runtime_source_commit"], configured_rpc_urls=rpc_urls, allows_public_rpcs=original["allows_public_rpcs"])
            proof["published_bytes"] = [{"path": str(item), "bytes": item.stat().st_size, "sha256": hashlib.sha256(item.read_bytes()).hexdigest()} for item in path.glob("*_with_id.json")]
            result.append(proof)
        require(result, "actual validator publication evidence missing")
        return result

    def zero_leaf_checkpoint_proof(self, snapshot, name):
        require(self.manifest["scenario"] in {"starknet", "sealevel", "sealevel-composite"}, "zero-leaf metadata-only family not supported")
        captures = [row for row in self.captures if row["original"]["role"] == "validator" and row["original"]["role_chain_names"] == [name]]
        require(captures, "zero-leaf proof has no actual configured validator")
        original, proxied = captures[-1]["original"], captures[-1]["proxied"]
        chain = original["chains"][name]
        domain = int(chain["domainid"])
        require(self.case["domain_names"].get(str(domain)) == name, "zero-leaf canonical chain/domain differs")
        messages = snapshot.get("messages")
        require(isinstance(messages, list) and messages, "canonical snapshot corpus missing")
        require(all((message["origin_chain"] == name) == (message["origin"] == domain) for message in messages), "canonical snapshot origin name/domain disagrees")
        origin = [message for message in messages if message["origin_chain"] == name]
        require(all(isinstance(message.get("insertions"), list) for message in origin), "canonical insertion evidence missing")
        leaves = sum(len(message["insertions"]) for message in origin)
        require(leaves == 0, "populated canonical origin requires signed checkpoint bytes")
        syncer = original["checkpoint_syncer"]
        require(syncer["type"] == "localStorage", "zero-leaf actual local metadata required")
        directory = self.owned_path(pathlib.Path(syncer["path"]).relative_to(self.manifest["task_root"]))
        require(directory.is_dir() and not any(directory.glob("*_with_id.json")), "zero-leaf origin has unexpected signed objects")
        path = self.owned_path(pathlib.Path(syncer["path"]).relative_to(self.manifest["task_root"]) / "metadata_latest.json")
        require(path.is_file() and not path.is_symlink(), "actual zero-leaf metadata missing/unsafe")
        raw = path.read_bytes()
        import urllib.parse
        selected = proxied["chains"][name]
        configured = []
        for base, custom in [("rpcurls", "customrpcurls"), ("grpcurls", "customgrpcurls"), ("walleturls", "customwalleturls"), ("walletsolidityurls", "customwalletsolidityurls")]:
            if custom in selected or base in selected:
                configured.extend(urls(selected[custom] if custom in selected else selected[base]))
        require(configured, "zero-leaf actual configured RPC metadata absent")
        metadata = {"git_sha": self.manifest["runtime_source_commit"], "rpcs": [{"url_hash": self.keccak(url), "host_hash": self.keccak(urllib.parse.urlsplit(url).hostname)} for url in configured], "allows_public_rpcs": original["allows_public_rpcs"]}
        require(json.loads(raw) == metadata, "actual zero-leaf ValidatorMetadata differs")
        return {"chain": name, "domain": domain, "canonical_origin_message_count": len(origin), "canonical_origin_leaf_count": leaves, "zero_leaf_origin_no_signature_credit": True, "metadata": metadata, "metadata_bytes": {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}, "verified_checkpoint_objects": [], "published_bytes": []}

    def checkpoint_publications(self, snapshot, proofs):
        require(isinstance(proofs, list) and proofs, "actual native checkpoint proof missing")
        result = []
        for proof in proofs:
            require(isinstance(proof, dict) and isinstance(proof.get("published_bytes"), list), "actual signed-object byte descriptors missing")
            if proof["published_bytes"]:
                require(proof.get("zero_leaf_origin_no_signature_credit", False) is False, "zero-leaf proof cannot claim signature credit")
                result.append(proof)
            else:
                require(proof.get("zero_leaf_origin_no_signature_credit") is True and proof.get("verified_checkpoint_objects") == [], "empty checkpoint proof lacks explicit verified zero-leaf contract")
                verified = self.zero_leaf_checkpoint_proof(snapshot, proof.get("chain"))
                require(proof.get("metadata") == verified["metadata"], "adapter zero-leaf metadata differs from actual bytes")
                for field in ("domain", "canonical_origin_message_count", "canonical_origin_leaf_count", "metadata_bytes"):
                    require(field not in proof or proof[field] == verified[field], "adapter zero-leaf canonical metadata binding differs")
                result.append(verified)
        return result

    def role_launch_epochs(self, launches):
        from collections import Counter
        require(isinstance(launches, list) and len(launches) == len(self.captures), "actual new role child identity coverage differs")
        identities = set()
        for row in launches:
            require(isinstance(row, dict) and row.get("role") in {"relayer", "validator", "scraper"} and row.get("executable") == self.manifest["artifacts"].get(row["role"]), "actual role launch executable differs")
            require(type(row.get("pid")) is int and row["pid"] > 0 and type(row.get("parent_pid")) is int and row["parent_pid"] > 0 and isinstance(row.get("os_start_token"), str) and row["os_start_token"], "actual role launch epoch missing")
            identity = row["pid"], row["parent_pid"], row["os_start_token"]
            require(identity not in identities, "duplicate/replayed actual role launch epoch")
            identities.add(identity)
        require(Counter(row["role"] for row in launches) == Counter(row["original"]["role"] for row in self.captures), "actual launch/capture role coverage differs")
        return identities

    def parent_wait_proofs(self, purpose="final"):
        from collections import Counter
        path = self.owned_path(self.evidence_relative / "parent-child-exits.jsonl")
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        require(rows and all(row.get("parent_wait_completed") is True for row in rows), "actual parent wait receipts missing")
        require(all(row.get("purpose") in {"final", "same_db_restart", "intentional_reorg", "intentional_restart"} for row in rows), "unexpected/unwind role exit cannot be final acceptance")
        final = [row for row in rows if row.get("purpose") == purpose]
        initial_count = self.initial["capture_count"]
        configured = Counter(row["original"]["role"] for row in self.captures[:initial_count])
        # The Source composite scenario configures no scraper. Other scenarios
        # still require all three roles, including every configured validator.
        expected_roles = {"relayer", "validator"} if self.manifest["scenario"] == "sealevel-composite" else {"relayer", "validator", "scraper"}
        require(set(configured) == expected_roles and Counter(row["role"] for row in final) == configured, "all actual configured daemon children must stop before database reads")
        for row in rows:
            require(row.get("already_exited") is False and row.get("forced_kill") is False, "unexpected/forced historical daemon shutdown")
            if row["purpose"] in {"final", "same_db_restart"}:
                require(row.get("success") is True and type(row.get("exit_code")) is int and row["exit_code"] == 0 and row.get("signal") is None, "final/restart daemon shutdown was not clean")
            else:
                require(row.get("planned_exit") is True and row.get("success") is False and row.get("exit_code") is None and row.get("signal") == 9, "intentional Source restart lacks actual planned parent kill/wait")
        launches_path = self.owned_path(self.evidence_relative / "owned-children.jsonl")
        launches = [json.loads(line) for line in launches_path.read_text().splitlines()]
        def identity(row):
            require(type(row.get("pid")) is int and row["pid"] > 0 and type(row.get("parent_pid")) is int and row["parent_pid"] > 0 and isinstance(row.get("os_start_token"), str) and row["os_start_token"], "actual child start identity missing")
            return row["pid"], row["parent_pid"], row["os_start_token"]
        launched = {identity(row): row for row in launches}
        reaped = {identity(row): row for row in rows}
        require(len(launched) == len(launches) == len(self.captures) and len(reaped) == len(rows) and set(reaped) == set(launched), "historical actual role child lacks unique parent wait receipt")
        require(Counter(row["role"] for row in launches) == Counter(row["original"]["role"] for row in self.captures), "actual launch/capture role coverage differs")
        for row in rows:
            require(row["role"] in expected_roles and row["executable"] == self.manifest["artifacts"][row["role"]], "parent receipt executable differs from pinned actual role")
            require(all(launched[identity(row)][key] == row[key] for key in ("role", "executable")), "parent exit receipt differs from actual child launch")
        return rows

    def stopped_store_proofs(self, snapshot):
        relayers = [row["original"] for row in self.captures if row["original"]["role"] == "relayer"]
        require(relayers and isinstance(relayers[-1].get("db"), str), "actual retained relayer DB missing")
        database = self.owned_path(pathlib.Path(relayers[-1]["db"]).relative_to(self.manifest["task_root"]))
        require(database.is_dir() and (database / "CURRENT").is_file() and not (database / "CURRENT").is_symlink(), "actual existing canonical Rocks database required")
        chains = relayers[-1]["chains"]
        namespaces = {str(chain["domainid"]): name for name, chain in chains.items()}
        delivered = {message["id"] for message in snapshot["deliverable_messages"]}
        expectations = None
        if self.manifest["scenario"] == "radix":
            require(self.family is not None and callable(getattr(self.family, "canonical_expenditure", None)), "actual Radix receipt-bound canonical expenditure contract missing")
            expectations = self.family.canonical_expenditure(snapshot)
            validate_expenditure_expectations(expectations, delivered)
        result = []
        for name, chain in chains.items():
            messages = [message for message in snapshot["messages"] if message["origin_chain"] == name]
            raw = run_tool(self.manifest, "oracle", ["relayer-probe-all", database, chain["domainid"], name, len(messages), json.dumps(namespaces, separators=(",", ":"))], timeout=60)
            probe = json.loads(raw)
            per_origin = None if expectations is None else {message["id"]: expectations[message["id"]] for message in messages if message["id"] in delivered}
            verified = verify_canonical_rocks(probe, chain, messages, delivered, expenditure_expectations=per_origin)
            result.append({"origin": name, "actual_Rust_output": probe, "verified_canonical_messages": verified})
        if self.manifest["scenario"] == "evm":
            snapshot["actual_EVM_accounting"] = verify_evm_accounting(snapshot, [row["actual_Rust_output"] for row in result], self.estimates, self.broadcasts, chains, lambda value: EvmEvidence(self.manifest, "unused").keccak(value), self.case["relayer_addresses"])
        return result

    def native_operation_proofs(self, snapshot, *, baseline=None):
        require(self.family is not None or self.manifest["scenario"] == "tron", "native protocol verifier must be explicit")
        latest = [row["original"] for row in self.captures if row["original"]["role"] == "relayer"][-1]
        database = self.owned_path(pathlib.Path(latest["db"]).relative_to(self.manifest["task_root"]))
        chains = latest["chains"]
        names = {int(chain["domainid"]): name for name, chain in chains.items()}
        if self.family is None:
            require(isinstance(self.case.get("relayer_addresses"), dict), "reviewed public relayer signer identities required")
        groups = {}
        for message in snapshot["deliverable_messages"]:
            groups.setdefault((message["origin_chain"], names[message["destination"]]), []).append(message)
        previous = {row["id"]: row["operation"] for row in baseline or []}
        transaction_proofs = {(row["chain"], row["transaction_hash"]): row["proof"] for row in snapshot["native_delivery_transactions"]}
        results = []
        for (origin, destination), messages in groups.items():
            require(len(messages) <= 256, "native reader operation bound exceeded")
            request = {"marker": "ziggy-native-rows-readonly-v1", "db_path": str(database), "origin_namespace": origin, "origin": int(chains[origin]["domainid"]), "destination": int(chains[destination]["domainid"]), "operations": [{"id": message["id"], "nonce": message["nonce"], "kind": "process", "target": None, "context": previous[message["id"]]["context"] if message["id"] in previous else None} for message in messages]}
            relative = self.evidence_relative / f"native-rows-request-{time.monotonic_ns()}.json"
            path = self.owned_path(relative)
            with path.open("x") as stream:
                json.dump(request, stream, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            raw = run_tool(self.manifest, "native_rows", [path], timeout=60)
            output = json.loads(raw)
            require(output.get("schema") == 1 and output.get("reader") == "independent Rust rocksdb native-row evidence" and output.get("readonly") is True and output.get("complete") is True, "actual native Rust row scan incomplete/not readonly")
            require(output.get("expected_origin") == request["origin"] and output.get("expected_destination") == request["destination"] and output.get("origin_namespace") == origin, "actual native Rust namespace/authority differs")
            require(output.get("configuration_authority_verified") is False and all(output.get(key) is True for key in ("parent_stopped_receipt_required", "sdk_verification_required", "canonical_old_oracle_required")), "native reader proof qualification changed")
            rows = output.get("rows")
            require(isinstance(rows, list) and len(rows) == len(messages), "native Rust row coverage differs")
            by_id = {row["id"]: row for row in rows}
            require(len(by_id) == len(rows) and set(by_id) == {message["id"] for message in messages}, "native Rust IDs differ")
            adapter = self.adapter(chains[destination]) if self.family is None else None
            for message in messages:
                row = by_id[message["id"]]
                require(row.get("present") is True and isinstance(row.get("operation"), dict), "native signed operation missing")
                operation = row["operation"]
                proof = adapter.verify_signed_operation(operation, message, chains[origin], chains[destination], self.case["relayer_addresses"][destination], transaction_proofs[(destination, message["delivery_transaction"])]) if adapter is not None else None
                if message["id"] in previous:
                    prior = previous[message["id"]]
                    require(operation.get("expected_context_checked") is True, "native reader did not check pinned restart context")
                    for key in ("context", "generation", "identity", "stored_canonical_intent", "signed"):
                        require(operation.get(key) == prior.get(key), "sameDB restart changed frozen native signed identity/authority/intent")
                    if operation["stage"] == prior["stage"] and operation["deadline"] == prior["deadline"]:
                        require(operation["row"] == prior["row"], "same-phase native operation bytes changed across restart")
                results.append({"id": message["id"], "operation": operation, "actual_native_crypto": proof})
        if self.family is not None:
            snapshot["family_native_row_proofs"] = self.family.native_rows(self, snapshot, results, baseline)
            require(isinstance(snapshot["family_native_row_proofs"], list) and snapshot["family_native_row_proofs"], "actual native family signature/authority/receipt/accounting proof missing")
        return results

    def postgres_proofs(self, snapshot):
        if self.family is not None:
            return self.family.sql(self, snapshot)
        databases = {}
        for capture in self.captures:
            original = capture["original"]
            if original["role"] == "scraper":
                for name in original["role_chain_names"]:
                    databases[name] = original["db"]
        require(set(databases) == set(self.case["chain_names"]), "actual scraper database coverage missing")
        # Explicit URI per Source scraper; psql never discovers a user service,
        # pgpass or psqlrc. Query both DBs when Source uses one DB per chain.
        def query(name, sql):
            import urllib.parse
            uri = databases[name]
            parsed = urllib.parse.urlsplit(uri)
            require(parsed.scheme in {"postgres", "postgresql"} and parsed.hostname in {"localhost", "127.0.0.1", "::1"} and not parsed.query and not parsed.fragment, "nonfixture/overridden PostgreSQL URI")
            # libpq URI query host/service parameters must not bypass the above
            # authority. Pin hostaddr directly, without consulting host DNS.
            direct = "127.0.0.1" if parsed.hostname == "localhost" else parsed.hostname
            uri = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode({"hostaddr": direct})))
            return run_tool(self.manifest, "psql", ["-X", "-A", "-t", "--no-password", "--dbname", uri, "-v", "ON_ERROR_STOP=1", "-c", sql])
        relayer = [row for row in self.captures if row["original"]["role"] == "relayer"][-1]["original"]
        names = {int(chain["domainid"]): name for name, chain in relayer["chains"].items()}
        delivered = {message["id"] for message in snapshot["deliverable_messages"]}
        result = []
        for message in snapshot["messages"]:
            origin = query(message["origin_chain"], sql_message_query(message))
            destination = query(names[message["destination"]], sql_delivery_query(message, message.get("delivery_transaction")))
            proof = verify_sql_message(origin, destination, message, delivered=message["id"] in delivered)
            metadata = message["event_metadata"]
            require(set(metadata) == {"dispatch", "insertion", "payment", "delivery"} and len(metadata["dispatch"]) == 1 and len(metadata["insertion"]) == len(message["insertions"]) and len(metadata["payment"]) == len(message["payments"]) and len(metadata["delivery"]) == int(message["id"] in delivered), "actual EVM/TRE event coordinate coverage differs")
            positions = []
            for kind, events in metadata.items():
                for event in events:
                    require(query(event["chain"], sql_event_query(kind, message["id"], event)).strip() == "1", "actual EVM/TRE SQL canonical event coordinates differ")
                    positions.append({"kind": kind, "metadata": event})
            proof["canonical_event_coordinates"] = positions
            result.append({"id": message["id"], "origin": message["origin_chain"], "destination": names[message["destination"]], "verified": proof})
        return result

    def diagnostic(self,stage,token=None,status=None,error=None):
        # Diagnostics never alter the actual verifier return/retry/exception.
        try:
            lock=getattr(self,'diagnostic_lock',None)
            if lock is None:return None
            with lock:
                if self.public_diagnostic_recorder is None:
                    path=self.owned_path(self.evidence_relative/'public-observer-diagnostics.json')
                    self.public_diagnostic_recorder=multivm_diagnostics.Recorder(path,self.approval['python_modules'],pathlib.Path(__file__).resolve().parent)
                recorder=self.public_diagnostic_recorder
            state=multivm_diagnostics.snapshot(self,time.monotonic_ns())
            if token is None:return recorder.enter(stage,state)
            recorder.finish(token,state,status,error)
        except Exception:
            self.public_diagnostic_write_failed=True
        return None

    def verify(self, stage, expected, harness_parent=None):
        if stage == 'after_restart':
            with self.restart_gate:
                if self.restart_deadline_ns is None:
                    self.restart_first_entry_ns = time.monotonic_ns()
                    self.restart_deadline_ns = self.restart_first_entry_ns + 120_000_000_000
        token=self.diagnostic(stage)
        try:
            result=self._verify(stage,expected,harness_parent)
        except Exception as error:
            if token is not None:self.diagnostic(stage,token,'exception',error)
            raise
        if token is not None:self.diagnostic(stage,token,'completed'if isinstance(result,dict)and result.get('verified')is True else'pending')
        return result

    def _init_restart_sampler(self):
        self.restart_gate = threading.Lock()
        self.restart_sample_gate = threading.RLock()
        self.restart_live_stop = threading.Event()
        self.restart_live_thread = None
        self.restart_baseline = None
        self.restart_deadline_ns = None
        self.restart_first_entry_ns = None
        self.restart_live_error = None
        self.restart_live_ready = False
        self.restart_published = False
        self.restart_phases = {}

    def _restart_phase(self, name, callback):
        started = time.monotonic_ns()
        token = self.diagnostic(name)
        try:
            result = callback()
        except Exception as error:
            if token is not None: self.diagnostic(name, token, 'exception', error)
            raise
        else:
            if token is not None: self.diagnostic(name, token, 'completed')
            return result
        finally:
            ended = time.monotonic_ns()
            require(started <= ended, 'restart proof phase clock rollback')
            self.restart_phases[name] = {'started_monotonic_ns': started, 'finished_monotonic_ns': ended}

    def _restart_context(self):
        from collections import Counter
        with self.lock:
            cutoff = self.initial['capture_count']
            captures = json.loads(json.dumps(self.captures))
            require(not self.failures and not self.lifecycle.errors, 'actual observer/lifecycle failed during restart')
            require(self.broadcasts == self.initial['broadcasts'], 'sameDB restart submitted an extra transaction')
        require(len(captures) > cutoff, 'restarted captures pending')
        def binding(row):
            return json.dumps({'original': row['original'], 'proxied': row['proxied']}, sort_keys=True, separators=(',', ':'))
        before = sorted(binding(row) for row in captures[:cutoff])
        after = sorted(binding(row) for row in captures[cutoff:])
        require(Counter(before) == Counter(after), 'restarted effective config/endpoint bindings differ')
        path = self.owned_path(self.evidence_relative / 'owned-children.jsonl')
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024*1024, 'bounded actual role launch journal required')
        launches = [json.loads(line) for line in path.read_text().splitlines()]
        # Existing coverage validator reads captures; recheck their bytes before
        # and after all external checks so another capture cannot cross a sample.
        self.role_launch_epochs(launches)
        children = launches[cutoff:]
        restarted = captures[cutoff:]
        clocks = {}
        for capture in restarted:
            for chain in capture['original']['role_chain_names']:
                key = capture['original']['role'] + ':' + chain
                clocks[key] = max(clocks.get(key, 0), capture['captured_monotonic_ns'])
        epoch = hashlib.sha256(json.dumps({'bindings': after, 'children': children}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        return {'captures': captures, 'restarted': restarted, 'children': children, 'epoch': epoch,
                'capture_clocks': clocks, 'before_hash': hashlib.sha256(json.dumps(before, separators=(',', ':')).encode()).hexdigest(),
                'after_hash': hashlib.sha256(json.dumps(after, separators=(',', ':')).encode()).hexdigest()}

    def _restart_control_artifacts(self):
        # Full source/cohort/dependency validation runs before the baseline and
        # at final acceptance. Continuous samples rehash their exact authority
        # and executed module bytes, without replaying expensive build gates.
        checked_artifact(self.manifest['execution_approval'])
        checked_artifact(self.manifest['case_inputs'])
        for row in self.approval['python_modules'].values(): checked_artifact(row)

    def _restart_admin(self, context, deadline_ns):
        snapshot = self.restart_baseline['snapshot']
        delivered = {message['id'].lower() for message in snapshot['deliverable_messages']}
        known = {message['id'].lower(): message for message in snapshot['messages']}
        results = []
        for capture in context['restarted']:
            role = capture['original']['role']
            original = capture['original']
            if role == 'relayer':
                operations, observations = collect_admin_sample(original['metrics_port'], original['chains'], deadline_ns, lambda row: self.append('restart-admin-timings.jsonl', row), self.stop.is_set)
                for name in original['role_chain_names']:
                    values = operations[name]
                    started = observations[name]['request_started_monotonic_ns']
                    seen = set()
                    for value in values:
                        identity = value.get('id', '').lower()
                        require(identity in known and identity not in delivered and identity not in seen and known[identity]['destination'] == int(original['chains'][name]['domainid']), 'foreign/cross-domain/duplicate/restored-delivered restart admin operation')
                        seen.add(identity)
                        operation = value.get('operation', {})
                        message = operation.get('message')
                        require(operation.get('type') == 'PendingMessage' and isinstance(message, dict)
                                and hashlib.sha256(json.dumps(message, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == admin_message_hash(known[identity]['wire']), 'restart admin message differs from canonical corpus')
                        status = json.dumps(operation.get('status'), sort_keys=True)
                        require(operation.get('submitted') is False and ('CouldNotFetchMetadata' in status or 'MessageMetadataRefused' in status), 'restart refused admin operation became submitted')
                    results.append({'role': role, 'chain': name, 'port': original['metrics_port'], 'request_started_monotonic_ns': started,
                                    'response_received_monotonic_ns': observations[name]['response_received_monotonic_ns'], 'operation_count': len(values)})
            else:
                row = restart_metrics_sample(original['metrics_port'], deadline_ns, self.stop.is_set)
                results.append({'role': role, 'chain': None, **row})
        return results

    def _restart_sample_once(self, *, background=False):
        # Serializes the sampler with the final publication check, never with
        # capture/transport callbacks. No Session.lock spans external I/O.
        with self.restart_sample_gate:
            if background and self.restart_live_stop.is_set(): return False
            with self.lock:
                deadline_ns = min(self.restart_deadline_ns, self.restart_window.samples[-1]['observed_monotonic_ns'] + OBSERVER_POLICY['maximum_successful_domain_sample_gap_ns'] + 1) if self.restart_window.samples else self.restart_deadline_ns
            require(time.monotonic_ns() < deadline_ns, 'original restart live sample deadline expired')
            self._restart_control_artifacts()
            context = self._restart_context()
            require(context == self.restart_baseline['context'], 'restarted capture/child/config epoch changed')
            for child in context['children']:
                remaining = (deadline_ns-time.monotonic_ns())/1_000_000_000
                require(remaining > 0, 'restart child-check deadline expired')
                require(not self.stop.is_set(), 'restart child-check cancelled')
                process_identity(self.manifest, child, timeout=min(1, remaining))
            admin = self._restart_admin(context, deadline_ns)
            require(self._restart_context() == context, 'restart epoch changed during actual readiness checks')
            with self.lock:
                require(self.captures == context['captures'] and self.broadcasts == self.initial['broadcasts'], 'restart capture/broadcast changed at sample commit')
                require(not self.stop.is_set() and not self.failures and not self.lifecycle.errors, 'actual observer/lifecycle failed/cancelled during restart sample')
                now = time.monotonic_ns()
                require(now >= self.restart_baseline['completed_monotonic_ns'], 'restart clock predates successful full baseline')
                require(now < deadline_ns, 'original whole live sample deadline expired')
                activity, starts = {}, {}
                for key, capture in context['capture_clocks'].items():
                    role, chain = key.split(':', 1)
                    pair = self.successful_activity.get((role, chain))
                    require(pair is not None and pair['request_started_monotonic_ns'] > capture and pair['response_received_monotonic_ns'] > capture, 'restarted role has no successful new-epoch physical exchange')
                    activity[key], starts[key] = pair['response_received_monotonic_ns'], pair['request_started_monotonic_ns']
                count = len(self.restart_window.samples)
                ready = self.restart_window.observe(now, context['epoch'], activity, starts)
                self.restart_live_ready = self.restart_live_ready or ready
                self.restart_last_live_check = {'observed_monotonic_ns': now, 'epoch_sha256': context['epoch'], 'actual_admin_readiness': admin, 'role_rpc_activity': dict(activity), 'role_rpc_request_started_ns': dict(starts)}
                if len(self.restart_window.samples) > count:
                    self.restart_window.samples[-1]['actual_admin_readiness'] = admin
                return self.restart_live_ready

    def _restart_sample_loop(self):
        while not self.restart_live_stop.is_set():
            token = self.diagnostic('restart_continuous')
            try:
                self._restart_sample_once(background=True)
            except Exception as error:
                with self.lock:
                    self.restart_window.invalidate()
                    if self.restart_window.failed or time.monotonic_ns() >= self.restart_deadline_ns:
                        self.restart_live_error = error
                if token is not None: self.diagnostic('restart_continuous', token, 'exception', error)
                if self.restart_live_error is not None: return
            else:
                if token is not None: self.diagnostic('restart_continuous', token, 'completed')
            self.restart_live_stop.wait(.5)

    def _restart_stop_sampler(self):
        self.restart_live_stop.set()
        if self.restart_live_thread is not None:
            self.restart_live_thread.join(timeout=5)
            require(not self.restart_live_thread.is_alive(), 'owned restart sampler did not drain')

    def _verify_restart(self, expected):
        with self.restart_gate:
            require(type(expected) is int and expected == self.case['initial_corpus']['deliveries'], 'restart expected corpus changed')
            if self.restart_deadline_ns is None:
                self.restart_first_entry_ns = time.monotonic_ns()
                self.restart_deadline_ns = self.restart_first_entry_ns + 120_000_000_000
            try:
                require(time.monotonic_ns() < self.restart_deadline_ns, 'Python first-entry120s restart deadline expired')
                if self.restart_published:
                    return {'verified': True, 'stage': 'after_restart'}
                require(self.restart_live_error is None and not self.restart_window.failed, 'restart continuous observer already failed')
                if self.restart_baseline is None:
                    require(self.before_restart is not None, 'actual stopped baseline missing')
                    self.approval = self._restart_phase('restart_approval', lambda: read_approval(self.manifest))
                    snapshot = self._restart_phase('restart_canonical', lambda: self.canonical_snapshot(expected, initial=True, phase='after_restart'))
                    def full_identity():
                        value = self._restart_context()
                        for child in value['children']:
                            remaining = (self.restart_deadline_ns-time.monotonic_ns())/1_000_000_000
                            require(remaining > 0, 'full identity proof reached original restart deadline')
                            process_identity(self.manifest, child, timeout=min(30, remaining))
                        return value
                    context = self._restart_phase('restart_identity', full_identity)
                    if self.family is not None:
                        snapshot['same_db_restart_readiness'] = self._restart_phase('restart_readiness', lambda: self.family.readiness(self, context['captures'][:self.initial['capture_count']], context['restarted']))
                    snapshot['checkpoint_proofs'] = self._restart_phase('restart_checkpoints', lambda: self.checkpoint_publications(snapshot, self.checkpoint_proofs(snapshot)))
                    require(self._restart_context() == context, 'restart epoch changed during full proof')
                    completed = time.monotonic_ns()
                    require(completed < self.restart_deadline_ns, 'full restart baseline exceeded Python first-entry120s deadline')
                    self.restart_baseline = {'snapshot': snapshot, 'context': context, 'completed_monotonic_ns': completed}
                    self.restart_live_thread = threading.Thread(target=self._restart_sample_loop, name='owned-restart-live-observer', daemon=True)
                    self.restart_live_thread.start()
                with self.lock:
                    ready = self.restart_live_ready
                if not ready: return {'verified': False, 'stage': 'after_restart'}
                # The worker keeps checking until the publishing caller arrives.
                # Recheck once under the same sample gate, then join BEFORE Rust
                # may begin its intentional final role teardown.
                with self.restart_sample_gate:
                    self.restart_live_stop.set()
                    self._restart_sample_once()
                self._restart_stop_sampler()
                with self.lock:
                    require(self.captures == self.restart_baseline['context']['captures'] and self.broadcasts == self.initial['broadcasts'], 'restart epoch/broadcast changed before publication')
                    require(self.restart_live_error is None and not self.failures and not self.lifecycle.errors, 'restart observer failed before publication')
                    proof = self.restart_window.evidence()
                now = time.monotonic_ns()
                require(now < self.restart_deadline_ns, 'late restart result cannot pass Python first-entry120s deadline')
                context = self.restart_baseline['context']
                proof.update(schema=2, clock_scope=RESTART_CLOCK_SCOPE,
                    full_baseline_completed_monotonic_ns=self.restart_baseline['completed_monotonic_ns'],
                    readiness_targets=[{'role':v['original']['role'],'port':v['original']['metrics_port'],'chains':list(v['original']['role_chain_names'])} for v in context['restarted']],
                    checker_first_entry_monotonic_ns=self.restart_first_entry_ns, checker_deadline_monotonic_ns=self.restart_deadline_ns,
                    checker_result_monotonic_ns=now, publication_live_check=dict(self.restart_last_live_check), checker_deadline_scope=RESTART_DEADLINE_SCOPE, full_baseline_phases=dict(self.restart_phases),
                    before_effective_config_sha256=context['before_hash'], after_effective_config_sha256=context['after_hash'],
                    new_capture_last_monotonic_ns=max(context['capture_clocks'].values()), new_capture_monotonic_ns_by_role_chain=dict(context['capture_clocks']),
                    new_child_identities=[{key: child[key] for key in ('role','pid','parent_pid','os_start_token','executable')} for child in context['children']])
                snapshot = self.restart_baseline['snapshot']
                snapshot['same_db_restart_observation'] = proof
                self.append('verified-after-restart.jsonl', snapshot)
                with self.lock:
                    require(self.captures == context['captures'] and self.broadcasts == self.initial['broadcasts'] and not self.failures and not self.lifecycle.errors and time.monotonic_ns() < self.restart_deadline_ns, 'restart changed/expired while publishing immutable evidence')
                    self.after_restart = snapshot
                    self.restart_published = True
                return {'verified': True, 'stage': 'after_restart'}
            except Exception:
                with self.lock: self.restart_window.invalidate()
                raise


    def _verify(self, stage, expected, harness_parent=None):
        if stage == "after_restart":
            return self._verify_restart(expected)
        try:
            read_approval(self.manifest)
        except Exception:
            if stage == 'after_restart':
                self.restart_window.invalidate()
            raise
        require(not self.failures, "actual observer failed")
        if stage == "preflight":
            if self.evidence_nodes:
                with self.lock:
                    self.prepare_devnets(harness_parent)
            return {"verified": True, "stage": stage, "observer_started_monotonic_ns": self.started_ns}
        if stage == "live":
            if self.initial is None:
                snapshot = self.canonical_snapshot(expected, initial=True)
                snapshot["checkpoint_proofs"] = self.checkpoint_publications(snapshot, self.checkpoint_proofs(snapshot))
                with self.lock:
                    self.initial = snapshot
                    self.sampling_finished = True
                self.append("verified-initial-native.jsonl", snapshot)
            return {"verified": True, "stage": stage}
        if stage == "before_restart":
            require(self.initial is not None and expected == self.case["initial_corpus"]["deliveries"], "actual initial600 proof missing")
            snapshot = self.canonical_snapshot(expected, initial=True)
            snapshot["parent_wait_receipts"] = self.parent_wait_proofs("same_db_restart")
            snapshot["stopped_canonical_Rust_readback"] = self.stopped_store_proofs(snapshot)
            if self.family is not None or self.manifest["scenario"] == "tron":
                snapshot["native_operations"] = self.native_operation_proofs(snapshot)
            self.before_restart = snapshot
            self.append("verified-before-restart.jsonl", snapshot)
            return {"verified": True, "stage": stage}
        if stage == "restart":
            require(self.initial is not None, "actual initial correctness evidence missing")
            relayers = [row for row in self.captures if row["original"]["role"] == "relayer"]
            require(relayers[-1]["capture_ordinal"] > self.initial["relayer_capture_ordinal"], "actual relayer restart capture absent")
            snapshot = self.canonical_snapshot(self.case["initial_corpus"]["deliveries"], initial=False, phase="after_source_reorg")
            require(self.broadcasts == self.initial["broadcasts"], "restart submitted an extra transaction")
            zeros = [message for message in snapshot["messages"] if not message["insertions"]]
            require(len(zeros) == expected, "actual zero-insertion restart expectation differs")
            active = []
            for name, chain in relayers[-1]["original"]["chains"].items():
                active.extend(admin_operations(relayers[-1]["original"]["metrics_port"], int(chain["domainid"])))
            by_id = {row["id"].lower(): row for row in active}
            require(len(by_id) == len(active), "duplicate restarted active identity")
            for message in zeros:
                require(message["id"] in by_id, "zero-insertion operation not restored")
                operation = by_id[message["id"]].get("operation", {})
                status = json.dumps(operation.get("status"), sort_keys=True)
                require(operation.get("submitted") is False and ("CouldNotFetchMetadata" in status or "MessageMetadataRefused" in status), "restart did not restore actual unavailable/refused metadata state")
            self.restart = snapshot
            self.append("verified-restart-native.jsonl", snapshot)
            return {"verified": True, "stage": stage}
        require(stage == "final", "unknown actual evidence stage")
        require(self.initial is not None and self.after_restart is not None and (self.manifest["scenario"] != "evm" or self.restart is not None), "actual live/restart gates have not completed")
        require(self.broadcasts == self.initial['broadcasts'], 'sameDB final proof observed an extra submission')
        waits = self.parent_wait_proofs()
        snapshot = self.canonical_snapshot(expected, initial=self.manifest["scenario"] != "evm", phase="final")
        for proof in self.initial["checkpoint_proofs"]:
            for row in proof["published_bytes"]:
                path = pathlib.Path(row["path"])
                require(path.is_file() and not path.is_symlink() and path.stat().st_size == row["bytes"] and hashlib.sha256(path.read_bytes()).hexdigest() == row["sha256"], "restart mutated prior signed checkpoint object")
        snapshot["parent_wait_receipts"] = waits
        snapshot["stopped_canonical_Rust_readback"] = self.stopped_store_proofs(snapshot)
        snapshot["checkpoint_proofs"] = self.checkpoint_publications(snapshot, self.checkpoint_proofs(snapshot))
        snapshot["postgres"] = self.postgres_proofs(snapshot)
        if self.family is not None or self.manifest["scenario"] == "tron":
            snapshot["native_operations"] = self.native_operation_proofs(snapshot, baseline=self.before_restart["native_operations"])
        self.restart_window.evidence() # Reject a later poisoned/incomplete window.
        snapshot['same_db_restart_observation'] = self.after_restart['same_db_restart_observation']
        snapshot['same_db_restart_readiness'] = self.after_restart.get('same_db_restart_readiness')
        snapshot['full_final_proof_completed_monotonic_ns'] = time.monotonic_ns()
        snapshot['full_final_proof_scope'] = RESTART_FINAL_SCOPE
        snapshot["verified"] = True
        self.append("verified-final-native.jsonl", snapshot)
        return {"verified": True, "stage": stage}

    def close(self):
        self.stop.set()
        self._restart_stop_sampler()
        self.sampler.join(timeout=5)
        require(not self.sampler.is_alive(), "owned lifecycle sampler did not drain")
        for proxy in self.proxies:
            proxy.close()

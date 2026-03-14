"""Hyperlane Fee Autopilot — Flask web app.

Serves a live dashboard and exposes JSON APIs for scanning and fee management.
"""

import json
import os
import sys
import time
import threading
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, render_template, jsonify, request, url_for

# Add project root to path
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

from main import load_config, cmd_scan, DATA_DIR, LATEST_SCAN
from engine.infra_snapshots import (
    InfraSnapshotError,
    create_refresh_job,
    create_snapshot,
    list_snapshots as list_infra_snapshots,
    load_refresh_job,
    load_snapshot,
    snapshot_freshness,
    update_refresh_job,
)

try:
    from engine.igp_submission import (
        IGPSubmissionError,
        approve_proposal,
        create_proposal,
        load_proposal,
        submit_proposal,
        update_proposal,
        validate_saved_proposal,
    )
except ImportError:  # pragma: no cover - optional module in this phase
    IGPSubmissionError = RuntimeError
    approve_proposal = None
    create_proposal = None
    load_proposal = None
    submit_proposal = None
    update_proposal = None
    validate_saved_proposal = None


app = Flask(__name__)

# Shared state for scan status
_scan_lock = threading.Lock()
_scan_status = {
    "running": False,
    "last_scan_time": None,
    "last_scan_duration": None,
    "error": None,
}
_infra_refresh_lock = threading.Lock()
_infra_refresh_state = {
    "running": False,
    "current_job_id": None,
    "last_job_id": None,
}

def _igp_submission_unavailable():
    return create_proposal is None


def _load_scan_data() -> dict | None:
    """Load latest scan data from disk."""
    if not LATEST_SCAN.exists():
        return None
    with open(LATEST_SCAN) as f:
        return json.load(f)


def _get_service_config() -> dict:
    return app.config.get("FEE_SYSTEM_CONFIG") or load_config()


def _infra_snapshots_dir():
    return app.config.get("INFRA_SNAPSHOTS_DIR")


def _infra_refresh_jobs_dir():
    return app.config.get("INFRA_REFRESH_JOBS_DIR")


def _stale_after_seconds(config: dict) -> int | None:
    interval_minutes = config.get("scan_frequency", {}).get("gas_prices_minutes")
    if not interval_minutes:
        return None
    return int(interval_minutes) * 120


def _snapshot_urls(snapshot_id: str) -> dict:
    return {
        "self": url_for("api_infra_snapshot_metadata", snapshot_ref=snapshot_id),
        "igp": url_for("api_infra_snapshot_igp", snapshot_ref=snapshot_id),
        "warp": url_for("api_infra_snapshot_warp", snapshot_ref=snapshot_id),
        "bundle": url_for("api_infra_snapshot_bundle", snapshot_ref=snapshot_id),
    }


def _snapshot_metadata_response(record: dict, config: dict) -> dict:
    manifest = dict(record["manifest"])
    manifest.update(snapshot_freshness(manifest, stale_after_seconds=_stale_after_seconds(config)))
    manifest["urls"] = _snapshot_urls(record["snapshot_id"])
    return manifest


def _create_infra_snapshot(config: dict, *, source_label: str, source_job_id: str | None = None) -> dict:
    scan_data = _load_scan_data()
    if not scan_data:
        raise InfraSnapshotError("No latest scan data available to snapshot")
    return create_snapshot(
        scan_data,
        config,
        snapshots_dir=_infra_snapshots_dir(),
        source=source_label,
        source_job_id=source_job_id,
    )


def _after_scan_success(config: dict, *, source_label: str, source_job_id: str | None = None) -> dict:
    return _create_infra_snapshot(config, source_label=source_label, source_job_id=source_job_id)


def _run_scan(
    config: dict,
    no_competitors: bool = False,
    *,
    source_label: str = "manual_scan",
    source_job_id: str | None = None,
):
    """Run a scan in the current thread, updating shared status."""
    global _scan_status
    with _scan_lock:
        if _scan_status["running"]:
            return {"ok": False, "error": "scan already running", "snapshot_id": None}
        _scan_status["running"] = True
        _scan_status["error"] = None

    start = time.time()
    snapshot_id = None
    try:
        # Build a minimal args object for cmd_scan
        class Args:
            pass
        args = Args()
        args.no_competitors = no_competitors
        args.monorepo = None
        cmd_scan(args, config)
        snapshot = _after_scan_success(
            config,
            source_label=source_label,
            source_job_id=source_job_id,
        )
        snapshot_id = snapshot["snapshot_id"]
        _scan_status["last_scan_time"] = time.time()
        _scan_status["last_scan_duration"] = round(time.time() - start, 1)
        return {"ok": True, "error": None, "snapshot_id": snapshot_id}
    except Exception as e:
        _scan_status["error"] = str(e)
        return {"ok": False, "error": str(e), "snapshot_id": snapshot_id}
    finally:
        _scan_status["running"] = False


# ── Routes ──────────────────────────────────────────────────────


@app.route("/")
def dashboard():
    """Render the live dashboard."""
    scan_data = _load_scan_data()
    config = _get_service_config()
    return render_template(
        "dashboard.html",
        scan=scan_data,
        config=config,
        scan_status=_scan_status,
        now=datetime.now(timezone.utc),
    )


@app.route("/api/data")
def api_data():
    """Return latest scan data as JSON."""
    scan_data = _load_scan_data()
    if not scan_data:
        return jsonify({"error": "No scan data. Run a scan first."}), 404
    scan_data["_scan_status"] = _scan_status
    return jsonify(scan_data)


@app.route("/api/scan", methods=["GET", "POST"])
def api_scan():
    """Trigger a scan.

    Default behavior includes competitor quotes.
    Opt out explicitly with `?no_competitors=1` (or POST JSON body).
    """
    if _scan_status["running"]:
        return jsonify({"status": "already_running"}), 409

    no_competitors = False
    # Explicit opt-out only.
    raw_q = (request.args.get("no_competitors") or "").strip().lower()
    if raw_q in {"1", "true", "yes", "on"}:
        no_competitors = True
    elif request.method == "POST":
        body = request.get_json(silent=True) or {}
        if isinstance(body, dict):
            no_competitors = bool(body.get("no_competitors", False))

    config = _get_service_config()

    thread = threading.Thread(
        target=_run_scan,
        args=(config, no_competitors),
        daemon=True,
    )
    thread.start()

    return jsonify({
        "status": "started",
        "no_competitors": no_competitors,
    })


@app.route("/api/scan/status")
def api_scan_status():
    """Return current scan status, including scheduler info."""
    try:
        from scheduler import get_next_run_time
    except ModuleNotFoundError:
        get_next_run_time = lambda: None
    status = dict(_scan_status)
    next_run = get_next_run_time()
    if next_run:
        status["next_scan_time"] = next_run
        status["next_scan_seconds"] = max(0, int(next_run - time.time()))
    return jsonify(status)


@app.route("/api/history")
def api_history():
    """Return historical data from SQLite."""
    from storage.history import get_gas_history, get_token_history

    hours = request.args.get("hours", 24, type=int)
    chain = request.args.get("chain")
    token = request.args.get("token")

    result = {}
    if chain:
        result["gas_history"] = get_gas_history(chain, hours)
    if token:
        result["token_history"] = get_token_history(token, hours)
    return jsonify(result)


@app.route("/api/fees", methods=["POST"])
def api_apply_fees():
    """Apply fee recommendations. Body: {routes: [...]} or {all: true}."""
    scan_data = _load_scan_data()
    if not scan_data:
        return jsonify({"error": "No scan data"}), 404

    config = _get_service_config()
    body = request.get_json(force=True) if request.data else {}

    from engine.safety import SafetyChecker
    from output.updater import write_update_files

    safety = SafetyChecker(config)
    cb = safety.check_circuit_breakers(
        {"gas": scan_data.get("gas_prices", {}),
         "tokens": scan_data.get("token_prices", {})},
        scan_data.get("token_prices", {}),
    )
    if cb.get("halt") and not body.get("force"):
        return jsonify({"error": "Circuit breaker active", "issues": cb["issues"]}), 403

    igp_recs = scan_data.get("igp_recommendations", {})
    warp_recs = scan_data.get("warp_recommendations", {})

    # Filter to requested routes if specified
    routes = body.get("routes")
    if routes:
        warp_recs = {k: v for k, v in warp_recs.items() if k in routes}

    output_dir = str(DATA_DIR / "updates")
    result = write_update_files(igp_recs, warp_recs, config["chains"], output_dir)

    # Audit log
    _log_fee_change(body, result)

    return jsonify(result)


def _log_fee_change(request_body: dict, result: dict):
    """Append to audit log."""
    log_dir = DATA_DIR / "audit"
    os.makedirs(log_dir, exist_ok=True)
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "request": request_body,
        "files_written": result.get("files_written", []),
        "diffs": result.get("diffs", []),
        "summary": result.get("summary", ""),
    }
    log_path = log_dir / "fee_changes.jsonl"
    with open(log_path, "a") as f:
        f.write(json.dumps(entry, default=str) + "\n")


@app.route("/api/rebalancer", methods=["POST"])
def api_rebalancer_push():
    """Accept live rebalancing cost data from the smart rebalancer.

    Expected JSON body:
    {
        "route_costs": {
            "ethereum->arbitrum": {"bps": 0.8, "confidence": 0.95},
            "arbitrum->base": {"bps": 1.2, "confidence": 0.90},
            ...
        },
        "timestamp": 1234567890
    }

    The smart rebalancer at ~/selfrelay/ should POST to this endpoint
    periodically (e.g., every 5 min) with its computed rebalancing costs.
    """
    body = request.get_json(force=True)
    if not body or "route_costs" not in body:
        return jsonify({"error": "Missing route_costs in body"}), 400

    # Store for use by the next scan/recommendation cycle
    _rebalancer_live_data.update(body)
    _rebalancer_live_data["received_at"] = time.time()

    return jsonify({
        "status": "ok",
        "routes_received": len(body.get("route_costs", {})),
    })


@app.route("/api/rebalancer", methods=["GET"])
def api_rebalancer_status():
    """Return current rebalancer integration status."""
    connected = bool(
        _rebalancer_live_data
        and time.time() - _rebalancer_live_data.get("received_at", 0) < 1800
    )
    return jsonify({
        "connected": connected,
        "data": _rebalancer_live_data if connected else None,
        "last_received": _rebalancer_live_data.get("received_at"),
    })


# Shared state for live rebalancer data
_rebalancer_live_data: dict = {}


@app.route("/api/audit")
def api_audit_log():
    """Return the fee change audit log."""
    log_path = DATA_DIR / "audit" / "fee_changes.jsonl"
    if not log_path.exists():
        return jsonify({"entries": []})

    entries = []
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))

    # Return newest first
    entries.reverse()
    limit = request.args.get("limit", 50, type=int)
    return jsonify({"entries": entries[:limit]})


def _run_infra_refresh_job(config: dict, *, job_id: str, no_competitors: bool) -> None:
    update_refresh_job(
        job_id,
        refresh_jobs_dir=_infra_refresh_jobs_dir(),
        status="running",
        started_at=datetime.now(timezone.utc).isoformat(),
    )
    try:
        result = _run_scan(
            config,
            no_competitors=no_competitors,
            source_label="manual_refresh",
            source_job_id=job_id,
        )
        if not result["ok"]:
            raise InfraSnapshotError(result["error"] or "refresh failed")
        update_refresh_job(
            job_id,
            refresh_jobs_dir=_infra_refresh_jobs_dir(),
            status="completed",
            completed_at=datetime.now(timezone.utc).isoformat(),
            snapshot_id=result["snapshot_id"],
        )
    except Exception as exc:
        update_refresh_job(
            job_id,
            refresh_jobs_dir=_infra_refresh_jobs_dir(),
            status="failed",
            completed_at=datetime.now(timezone.utc).isoformat(),
            error=str(exc),
        )
    finally:
        with _infra_refresh_lock:
            _infra_refresh_state["running"] = False
            _infra_refresh_state["current_job_id"] = None
            _infra_refresh_state["last_job_id"] = job_id


@app.route("/api/infra/status", methods=["GET"])
def api_infra_status():
    """Return scheduler, refresh, and latest snapshot status for Infra consumers."""
    try:
        from scheduler import get_next_run_time
    except ModuleNotFoundError:
        get_next_run_time = lambda: None

    config = _get_service_config()
    next_run = get_next_run_time()
    latest = None
    try:
        latest = _snapshot_metadata_response(
            load_snapshot("latest", snapshots_dir=_infra_snapshots_dir()),
            config,
        )
    except InfraSnapshotError:
        latest = None

    return jsonify(
        {
            "scheduler": {
                "next_scan_time": next_run,
                "next_scan_seconds": max(0, int(next_run - time.time())) if next_run else None,
                "last_scan_time": _scan_status.get("last_scan_time"),
                "last_scan_duration": _scan_status.get("last_scan_duration"),
                "scan_running": _scan_status.get("running", False),
                "scan_error": _scan_status.get("error"),
            },
            "refresh": dict(_infra_refresh_state),
            "latest_snapshot": latest,
        }
    )


@app.route("/api/infra/snapshots", methods=["GET"])
def api_infra_list_snapshots():
    """List persisted Infra snapshots newest first."""
    config = _get_service_config()
    limit = request.args.get("limit", 20, type=int)
    entries = []
    for item in list_infra_snapshots(snapshots_dir=_infra_snapshots_dir())[: max(1, limit)]:
        entries.append(_snapshot_metadata_response({"snapshot_id": item["snapshot_id"], "manifest": item["manifest"]}, config))
    return jsonify({"snapshots": entries})


@app.route("/api/infra/snapshots/<snapshot_ref>", methods=["GET"])
def api_infra_snapshot_metadata(snapshot_ref: str):
    """Return metadata for a specific Infra snapshot or latest alias."""
    config = _get_service_config()
    try:
        record = load_snapshot(snapshot_ref, snapshots_dir=_infra_snapshots_dir())
        return jsonify(_snapshot_metadata_response(record, config))
    except InfraSnapshotError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/infra/snapshots/<snapshot_ref>/igp-config", methods=["GET"])
def api_infra_snapshot_igp(snapshot_ref: str):
    """Return the final IGP config payload for a snapshot."""
    config = _get_service_config()
    try:
        record = load_snapshot(snapshot_ref, snapshots_dir=_infra_snapshots_dir())
        payload = {
            "snapshot": _snapshot_metadata_response(record, config),
            "config": record["igp"],
        }
        return jsonify(payload)
    except InfraSnapshotError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/infra/snapshots/<snapshot_ref>/warp-config", methods=["GET"])
def api_infra_snapshot_warp(snapshot_ref: str):
    """Return the final warp fee config payload for a snapshot."""
    config = _get_service_config()
    try:
        record = load_snapshot(snapshot_ref, snapshots_dir=_infra_snapshots_dir())
        payload = {
            "snapshot": _snapshot_metadata_response(record, config),
            "config": record["warp"],
        }
        return jsonify(payload)
    except InfraSnapshotError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/infra/snapshots/<snapshot_ref>/config-bundle", methods=["GET"])
def api_infra_snapshot_bundle(snapshot_ref: str):
    """Return the combined IGP + warp config payload for a snapshot."""
    config = _get_service_config()
    try:
        record = load_snapshot(snapshot_ref, snapshots_dir=_infra_snapshots_dir())
        payload = {
            "snapshot": _snapshot_metadata_response(record, config),
            "config": record["bundle"],
        }
        return jsonify(payload)
    except InfraSnapshotError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/infra/refresh", methods=["POST"])
def api_infra_refresh():
    """Trigger a new async scan + recommendation refresh for Infra snapshots."""
    with _infra_refresh_lock:
        if _infra_refresh_state["running"] or _scan_status["running"]:
            return jsonify({"error": "refresh already running"}), 409
        body = request.get_json(silent=True) or {}
        config = _get_service_config()
        job = create_refresh_job(
            refresh_jobs_dir=_infra_refresh_jobs_dir(),
            requested_by=body.get("requested_by", "api"),
            no_competitors=bool(body.get("no_competitors", False)),
        )
        _infra_refresh_state["running"] = True
        _infra_refresh_state["current_job_id"] = job["job_id"]
        _infra_refresh_state["last_job_id"] = job["job_id"]
        thread = threading.Thread(
            target=_run_infra_refresh_job,
            kwargs={
                "config": config,
                "job_id": job["job_id"],
                "no_competitors": bool(body.get("no_competitors", False)),
            },
            daemon=True,
        )
        thread.start()
        return jsonify(
            {
                "job_id": job["job_id"],
                "status": job["status"],
                "status_url": url_for("api_infra_refresh_status", job_id=job["job_id"]),
            }
        ), 202


@app.route("/api/infra/refresh/<job_id>", methods=["GET"])
def api_infra_refresh_status(job_id: str):
    """Return async Infra refresh job state."""
    try:
        return jsonify(load_refresh_job(job_id, refresh_jobs_dir=_infra_refresh_jobs_dir()))
    except InfraSnapshotError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/igp/proposals", methods=["POST"])
def api_igp_create_proposal():
    """Create a new IGP proposal from latest scan + monorepo mainnet3 config."""
    if _igp_submission_unavailable():
        return jsonify({"error": "IGP submission module is unavailable"}), 503
    config = _get_service_config()
    body = request.get_json(silent=True) or {}
    managed = body.get("managed_chains")
    operator = body.get("operator", "api")
    try:
        proposal = create_proposal(config, operator=operator, managed_chains=managed)
        return jsonify(proposal), 201
    except IGPSubmissionError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/igp/proposals/<proposal_id>", methods=["GET"])
def api_igp_get_proposal(proposal_id: str):
    """Get proposal details."""
    if _igp_submission_unavailable():
        return jsonify({"error": "IGP submission module is unavailable"}), 503
    try:
        proposal = load_proposal(proposal_id)
        return jsonify(proposal)
    except IGPSubmissionError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/igp/proposals/<proposal_id>", methods=["PUT"])
def api_igp_update_proposal(proposal_id: str):
    """Apply user edits and optionally approve."""
    if _igp_submission_unavailable():
        return jsonify({"error": "IGP submission module is unavailable"}), 503
    config = _get_service_config()
    body = request.get_json(force=True) if request.data else {}
    edits = body.get("edits", [])
    operator = body.get("operator", "api")
    try:
        proposal = update_proposal(config, proposal_id, edits, operator=operator)
        if body.get("approve"):
            phrase = body.get("confirmation_phrase")
            if not phrase:
                return jsonify(
                    {"error": "confirmation_phrase is required when approve=true"}
                ), 400
            proposal = approve_proposal(
                config,
                proposal_id,
                phrase,
                force=bool(body.get("force", False)),
            )
        return jsonify(proposal)
    except IGPSubmissionError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/igp/proposals/<proposal_id>/validate", methods=["POST"])
def api_igp_validate_proposal(proposal_id: str):
    """Validate proposal schema/safety/range constraints."""
    if _igp_submission_unavailable():
        return jsonify({"error": "IGP submission module is unavailable"}), 503
    config = _get_service_config()
    body = request.get_json(silent=True) or {}
    force = bool(body.get("force", False))
    try:
        result = validate_saved_proposal(config, proposal_id, force=force)
        status = 200 if result.get("ok") else 422
        return jsonify(result), status
    except IGPSubmissionError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/igp/proposals/<proposal_id>/submit", methods=["POST"])
def api_igp_submit_proposal(proposal_id: str):
    """Submit proposal through configured monorepo backend after confirmation phrase."""
    if _igp_submission_unavailable():
        return jsonify({"error": "IGP submission module is unavailable"}), 503
    config = _get_service_config()
    body = request.get_json(force=True) if request.data else {}
    phrase = body.get("confirmation_phrase")
    if not phrase:
        return jsonify({"error": "confirmation_phrase is required"}), 400
    try:
        result = submit_proposal(
            config,
            proposal_id,
            confirmation_phrase=phrase,
            dry_run=bool(body.get("dry_run", False)),
            force=bool(body.get("force", False)),
        )
        state = result.get("status")
        if state in {"submitted", "aborted"}:
            status = 200
        elif state == "failed":
            status = 500
        else:
            status = 500
        return jsonify(result), status
    except IGPSubmissionError as e:
        msg = str(e)
        lowered = msg.lower()
        if any(
            token in lowered
            for token in (
                "validation failed",
                "circuit breaker",
                "stale",
                "max_delta_pct",
                "hash mismatch",
                "confirmation phrase mismatch",
            )
        ):
            return jsonify({"error": msg}), 422
        return jsonify({"error": msg}), 400


def create_app(config: dict = None) -> Flask:
    """Factory for creating the Flask app with config."""
    if config:
        app.config["FEE_SYSTEM_CONFIG"] = config
    return app

"""Durable snapshot storage for Infra-facing fee recommendations."""

from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from engine.igp_submission import IGPSubmissionError, _get_managed_chains
from engine.monorepo_adapter import compute_floor_overrides
from output.updater import (
    build_config_bundle_payload,
    build_igp_config_payload,
    build_warp_config_payload,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_SNAPSHOTS_DIR = DATA_DIR / "infra_snapshots"
DEFAULT_REFRESH_JOBS_DIR = DATA_DIR / "infra_refresh_jobs"
LATEST_POINTER = "latest.json"


class InfraSnapshotError(RuntimeError):
    """Raised when Infra snapshot operations fail."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stable_hash(payload: dict) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return sha256(encoded.encode("utf-8")).hexdigest()


def _json_dump(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(payload, f, indent=2, sort_keys=False)
        f.write("\n")


def _json_load(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def _resolve_dir(raw: str | Path | None, default_dir: Path) -> Path:
    if raw is None:
        return default_dir
    return Path(raw)


def _managed_chains(config: dict) -> list[str]:
    try:
        return _get_managed_chains(config)
    except IGPSubmissionError:
        return list(config.get("chains", {}).keys())


def build_snapshot_payloads(scan_data: dict, config: dict) -> dict:
    """Build the canonical service payloads for IGP and warp."""
    igp_recs = scan_data.get("igp_recommendations", {})
    warp_recs = scan_data.get("warp_recommendations", {})
    chains_cfg = config.get("chains", {})
    delivery_costs = scan_data.get("delivery_costs", {})
    managed_chains = _managed_chains(config)

    igp_payload = build_igp_config_payload(
        igp_recs,
        chains_cfg,
        delivery_costs=delivery_costs,
        managed_chains=managed_chains,
    )
    warp_payload = build_warp_config_payload(warp_recs)
    bundle_payload = build_config_bundle_payload(
        igp_recs,
        warp_recs,
        chains_cfg,
        delivery_costs=delivery_costs,
        managed_chains=managed_chains,
    )
    return {
        "igp": igp_payload,
        "warp": warp_payload,
        "bundle": bundle_payload,
        "floor_overrides": compute_floor_overrides(chains_cfg, delivery_costs, managed_chains),
    }


def create_snapshot(
    scan_data: dict,
    config: dict,
    *,
    snapshots_dir: str | Path | None = None,
    source: str = "scan",
    source_job_id: str | None = None,
) -> dict:
    """Persist a completed Infra recommendation snapshot."""
    root = _resolve_dir(snapshots_dir, DEFAULT_SNAPSHOTS_DIR)
    root.mkdir(parents=True, exist_ok=True)

    payloads = build_snapshot_payloads(scan_data, config)
    created_at = _now_iso()
    snapshot_hash = _stable_hash(payloads["bundle"])
    snapshot_id = (
        f"infra-{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f')}"
        f"-{snapshot_hash[:8]}"
    )
    snapshot_dir = root / snapshot_id
    snapshot_dir.mkdir(parents=True, exist_ok=False)

    manifest = {
        "snapshot_id": snapshot_id,
        "created_at": created_at,
        "source": source,
        "source_job_id": source_job_id,
        "scan_timestamp": scan_data.get("timestamp"),
        "scan_generated_at": scan_data.get("generated_at"),
        "content_hash": snapshot_hash,
        "managed_chains": _managed_chains(config),
        "igp_chain_count": len(payloads["igp"].get("gas_prices", {})),
        "warp_route_count": len(payloads["warp"].get("routes", {})),
    }

    _json_dump(snapshot_dir / "manifest.json", manifest)
    _json_dump(snapshot_dir / "igp_config.json", payloads["igp"])
    _json_dump(snapshot_dir / "warp_config.json", payloads["warp"])
    _json_dump(snapshot_dir / "config_bundle.json", payloads["bundle"])
    _json_dump(root / LATEST_POINTER, {"snapshot_id": snapshot_id})

    return {
        "snapshot_id": snapshot_id,
        "snapshot_dir": str(snapshot_dir),
        "manifest": manifest,
        "igp": payloads["igp"],
        "warp": payloads["warp"],
        "bundle": payloads["bundle"],
    }


def _resolve_snapshot_id(snapshot_ref: str, snapshots_dir: str | Path | None = None) -> str:
    root = _resolve_dir(snapshots_dir, DEFAULT_SNAPSHOTS_DIR)
    if snapshot_ref != "latest":
        return snapshot_ref
    pointer = root / LATEST_POINTER
    if not pointer.exists():
        raise InfraSnapshotError("No completed Infra snapshots are available yet")
    return _json_load(pointer).get("snapshot_id")


def load_snapshot(snapshot_ref: str = "latest", *, snapshots_dir: str | Path | None = None) -> dict:
    """Load a persisted Infra snapshot by id or latest alias."""
    root = _resolve_dir(snapshots_dir, DEFAULT_SNAPSHOTS_DIR)
    snapshot_id = _resolve_snapshot_id(snapshot_ref, snapshots_dir=root)
    snapshot_dir = root / snapshot_id
    if not snapshot_dir.exists():
        raise InfraSnapshotError(f"Unknown Infra snapshot: {snapshot_ref}")

    return {
        "snapshot_id": snapshot_id,
        "manifest": _json_load(snapshot_dir / "manifest.json"),
        "igp": _json_load(snapshot_dir / "igp_config.json"),
        "warp": _json_load(snapshot_dir / "warp_config.json"),
        "bundle": _json_load(snapshot_dir / "config_bundle.json"),
    }


def list_snapshots(*, snapshots_dir: str | Path | None = None) -> list[dict]:
    """List persisted Infra snapshots newest first."""
    root = _resolve_dir(snapshots_dir, DEFAULT_SNAPSHOTS_DIR)
    if not root.exists():
        return []

    entries = []
    for child in root.iterdir():
        if not child.is_dir():
            continue
        manifest_path = child / "manifest.json"
        if not manifest_path.exists():
            continue
        manifest = _json_load(manifest_path)
        entries.append({"snapshot_id": manifest["snapshot_id"], "manifest": manifest})

    return sorted(entries, key=lambda item: item["manifest"].get("created_at", ""), reverse=True)


def create_refresh_job(
    *,
    refresh_jobs_dir: str | Path | None = None,
    requested_by: str = "api",
    no_competitors: bool = False,
) -> dict:
    """Create an async refresh job record."""
    root = _resolve_dir(refresh_jobs_dir, DEFAULT_REFRESH_JOBS_DIR)
    root.mkdir(parents=True, exist_ok=True)

    job_id = f"infra-refresh-{uuid.uuid4().hex[:12]}"
    job = {
        "job_id": job_id,
        "status": "queued",
        "requested_at": _now_iso(),
        "requested_by": requested_by,
        "no_competitors": bool(no_competitors),
        "started_at": None,
        "completed_at": None,
        "snapshot_id": None,
        "error": None,
    }
    _json_dump(root / f"{job_id}.json", job)
    return job


def update_refresh_job(
    job_id: str,
    *,
    refresh_jobs_dir: str | Path | None = None,
    **fields,
) -> dict:
    """Update a refresh job manifest."""
    root = _resolve_dir(refresh_jobs_dir, DEFAULT_REFRESH_JOBS_DIR)
    path = root / f"{job_id}.json"
    if not path.exists():
        raise InfraSnapshotError(f"Unknown Infra refresh job: {job_id}")
    payload = _json_load(path)
    payload.update(fields)
    _json_dump(path, payload)
    return payload


def load_refresh_job(job_id: str, *, refresh_jobs_dir: str | Path | None = None) -> dict:
    """Load a refresh job manifest."""
    root = _resolve_dir(refresh_jobs_dir, DEFAULT_REFRESH_JOBS_DIR)
    path = root / f"{job_id}.json"
    if not path.exists():
        raise InfraSnapshotError(f"Unknown Infra refresh job: {job_id}")
    return _json_load(path)


def snapshot_freshness(manifest: dict, *, stale_after_seconds: int | None = None) -> dict:
    """Return derived freshness metadata for a snapshot manifest."""
    created_at = manifest.get("created_at")
    if not created_at:
        return {"age_seconds": None, "is_stale": None}
    created_ts = datetime.fromisoformat(created_at).timestamp()
    age_seconds = max(0, int(time.time() - created_ts))
    return {
        "age_seconds": age_seconds,
        "is_stale": age_seconds > stale_after_seconds if stale_after_seconds is not None else None,
    }

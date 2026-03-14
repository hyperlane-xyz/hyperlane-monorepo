"""IGP submission workflow (v2, mainnet3-only)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from engine.safety import SafetyChecker


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
LATEST_SCAN = DATA_DIR / "latest_scan.json"
PROPOSALS_DIR = DATA_DIR / "igp_proposals"
AUDIT_LOG = DATA_DIR / "audit" / "igp_submissions.jsonl"
MAINNET3_GAS_PATH = (
    "typescript/infra/config/environments/mainnet3/gasPrices.json"
)
MAINNET3_TOKEN_PATH = (
    "typescript/infra/config/environments/mainnet3/tokenPrices.json"
)
MAINNET3_IGP_TS_PATH = (
    "typescript/infra/config/environments/mainnet3/igp.ts"
)
DEPLOY_TS_PATH = "typescript/infra/scripts/deploy.ts"
MAINNET3_SUPPORTED_CHAINS_PATH = (
    "typescript/infra/config/environments/mainnet3/supportedChainNames.ts"
)


class IGPSubmissionError(Exception):
    """Raised when proposal lifecycle steps cannot proceed."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _proposal_path(proposal_id: str) -> Path:
    return PROPOSALS_DIR / f"{proposal_id}.json"


def _load_json(path: Path) -> Any:
    with open(path) as f:
        return json.load(f)


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(payload, f, indent=2, sort_keys=False)
        f.write("\n")


def _stable_hash(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _is_number(value: Any) -> bool:
    try:
        float(str(value))
        return True
    except (TypeError, ValueError):
        return False


def _format_number(value: float, max_decimals: int = 8) -> str:
    as_str = f"{value:.{max_decimals}f}".rstrip("0").rstrip(".")
    return as_str or "0"


def _expand_monorepo_path(config: dict) -> Path:
    igp_cfg = config.get("igp_submission", {})
    raw = igp_cfg.get(
        "monorepo_path",
        str(PROJECT_ROOT / "data" / "vendor" / "hyperlane-monorepo"),
    )
    expanded = Path(os.path.expanduser(str(raw)))
    if expanded.is_absolute():
        return expanded.resolve()
    return (PROJECT_ROOT / expanded).resolve()


def _get_submission_backend(config: dict) -> str:
    backend = str(
        config.get("igp_submission", {}).get("execution_backend", "deploy")
    ).strip()
    if backend not in {"deploy", "check_govern"}:
        raise IGPSubmissionError(
            f"Invalid igp_submission.execution_backend={backend!r}; expected deploy|check_govern"
        )
    return backend


def _should_disable_monorepo_min_usd_floor(config: dict) -> bool:
    return bool(
        config.get("igp_submission", {}).get(
            "disable_monorepo_min_usd_floor", True
        )
    )


def _should_deploy_concurrently(config: dict) -> bool:
    return bool(config.get("igp_submission", {}).get("deploy_concurrent", True))


def _validate_monorepo_runtime_artifacts(monorepo_path: Path, backend: str) -> None:
    required_files = [
        monorepo_path / "typescript" / "sdk" / "dist" / "index.js",
    ]
    if backend == "deploy":
        required_files.append(
            monorepo_path
            / "typescript"
            / "core"
            / "dist"
            / "buildArtifact.js"
        )
    missing = [str(p) for p in required_files if not p.exists()]
    if missing:
        raise IGPSubmissionError(
            "Monorepo runtime is missing built artifacts. Missing: "
            + ", ".join(missing)
            + ". Build once with `pnpm install && pnpm build` in the managed monorepo path."
        )


def _ensure_managed_monorepo_checkout(config: dict) -> Path:
    igp_cfg = config.get("igp_submission", {})
    monorepo_path = _expand_monorepo_path(config)
    auto_update = bool(igp_cfg.get("monorepo_auto_update", True))
    repo_url = str(
        igp_cfg.get(
            "monorepo_repo_url",
            "https://github.com/hyperlane-xyz/hyperlane-monorepo.git",
        )
    ).strip()
    ref = str(igp_cfg.get("monorepo_ref", "main")).strip()

    if monorepo_path.exists():
        # If user points to a non-git directory, treat it as pre-provisioned and do not mutate.
        if not (monorepo_path / ".git").exists():
            return monorepo_path
        if not auto_update:
            return monorepo_path
    else:
        monorepo_path.parent.mkdir(parents=True, exist_ok=True)
        clone_result = subprocess.run(
            ["git", "clone", "--filter=blob:none", repo_url, str(monorepo_path)],
            capture_output=True,
            text=True,
        )
        if clone_result.returncode != 0:
            raise IGPSubmissionError(
                "Failed to clone monorepo runtime checkout: "
                + (clone_result.stderr.strip() or clone_result.stdout.strip())
            )

    fetch_result = subprocess.run(
        ["git", "-C", str(monorepo_path), "fetch", "--depth", "1", "origin", ref],
        capture_output=True,
        text=True,
    )
    if fetch_result.returncode != 0:
        raise IGPSubmissionError(
            f"Failed to fetch monorepo ref {ref!r}: "
            + (fetch_result.stderr.strip() or fetch_result.stdout.strip())
        )

    checkout_result = subprocess.run(
        ["git", "-C", str(monorepo_path), "checkout", "--detach", "FETCH_HEAD"],
        capture_output=True,
        text=True,
    )
    if checkout_result.returncode != 0:
        raise IGPSubmissionError(
            f"Failed to checkout monorepo ref {ref!r}: "
            + (checkout_result.stderr.strip() or checkout_result.stdout.strip())
        )

    return monorepo_path


def _read_mainnet3_supported_chains(monorepo_path: Path) -> set[str]:
    path = monorepo_path / MAINNET3_SUPPORTED_CHAINS_PATH
    if not path.exists():
        raise IGPSubmissionError(f"Missing supportedChainNames file: {path}")

    text = path.read_text()
    m = re.search(r"mainnet3SupportedChainNames\s*=\s*\[(.*?)\]", text, re.S)
    if not m:
        m = re.search(r"supportedChainNames\s*=\s*\[(.*?)\]", text, re.S)
    if not m:
        raise IGPSubmissionError(
            f"Could not parse supported chains from {path}"
        )
    body = m.group(1)
    return set(re.findall(r"'([^']+)'", body))


def _read_mainnet3_config_files(monorepo_path: Path) -> tuple[dict, dict]:
    gas_path = monorepo_path / MAINNET3_GAS_PATH
    token_path = monorepo_path / MAINNET3_TOKEN_PATH
    if not gas_path.exists():
        raise IGPSubmissionError(f"Missing gasPrices.json: {gas_path}")
    if not token_path.exists():
        raise IGPSubmissionError(f"Missing tokenPrices.json: {token_path}")
    return _load_json(gas_path), _load_json(token_path)


def _get_managed_chains(config: dict, override: list[str] | None = None) -> list[str]:
    if override:
        chains = [c for c in override if c]
    else:
        chains = list(config.get("igp_submission", {}).get("managed_chains", []))
    if not chains:
        raise IGPSubmissionError(
            "No managed chains configured. Set igp_submission.managed_chains."
        )
    # Preserve order but dedupe.
    return list(dict.fromkeys(chains))


def _canonical_submission_payload(proposal: dict) -> dict:
    chain_rows = []
    for row in sorted(proposal.get("chains", []), key=lambda r: r["chain"]):
        chain_rows.append(
            {
                "chain": row["chain"],
                "is_sealevel": bool(row.get("is_sealevel")),
                "gas_decimals": row.get("gas_decimals"),
                "proposed_gas_amount": row.get("proposed_gas_amount"),
                "proposed_token_price": row.get("proposed_token_price"),
            }
        )
    return {
        "managed_chains": sorted(proposal.get("managed_chains", [])),
        "base_scan_timestamp": proposal.get("base_scan_timestamp"),
        "chains": chain_rows,
    }


def _compute_diff_summary(chains: list[dict]) -> str:
    gas_changes = 0
    token_changes = 0
    for row in chains:
        if str(row.get("current_gas_amount")) != str(row.get("proposed_gas_amount")):
            gas_changes += 1
        if str(row.get("current_token_price")) != str(
            row.get("proposed_token_price")
        ):
            token_changes += 1
    return f"{gas_changes} gas changes, {token_changes} token price changes"


def _parse_result_artifacts(stdout: str, stderr: str) -> dict:
    merged = f"{stdout}\n{stderr}"
    signer_hashes = re.findall(r"Confirmed tx (0x[a-fA-F0-9]{64})", merged)
    safe_hashes = re.findall(
        r"Proposed transaction on [\w-]+ with hash (0x[a-fA-F0-9]{64})", merged
    )
    manual_payloads = []
    if "Please submit the following manually" in merged:
        manual_payloads.append("manual_submission_required")
    return {
        "signer_tx_hashes": list(dict.fromkeys(signer_hashes)),
        "safe_tx_hashes": list(dict.fromkeys(safe_hashes)),
        "manual_payloads": manual_payloads,
    }


def _append_audit_log(entry: dict) -> None:
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(AUDIT_LOG, "a") as f:
        f.write(json.dumps(entry, default=str) + "\n")


def _load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    entries: list[dict] = []
    with open(path) as f:
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    entries.append(parsed)
            except json.JSONDecodeError:
                continue
    return entries


def _idempotency_already_submitted(idempotency_key: str | None) -> bool:
    if not idempotency_key:
        return False
    for entry in _load_jsonl(AUDIT_LOG):
        if (
            entry.get("submission_idempotency_key") == idempotency_key
            and entry.get("status") == "submitted"
        ):
            return True
    return False


def _check_submit_circuit_breaker(config: dict, force: bool = False) -> list[str]:
    if not LATEST_SCAN.exists():
        raise IGPSubmissionError("Circuit breaker preflight requires data/latest_scan.json")

    scan_data = _load_json(LATEST_SCAN)
    safety = SafetyChecker(config)
    breaker = safety.check_circuit_breakers(
        {
            "gas": scan_data.get("gas_prices", {}),
            "tokens": scan_data.get("token_prices", {}),
        },
        scan_data.get("token_prices", {}),
    )
    if breaker.get("halt") and not force:
        issues = breaker.get("issues", []) or ["unknown issue"]
        raise IGPSubmissionError(
            "Circuit breaker active: " + "; ".join(str(i) for i in issues)
        )
    if breaker.get("halt"):
        return [f"circuit breaker override (force=true): {msg}" for msg in breaker.get("issues", [])]
    return []


def _local_monorepo_commit(monorepo_path: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(monorepo_path), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise IGPSubmissionError(
            f"Failed to read monorepo commit: {result.stderr.strip()}"
        )
    return result.stdout.strip()


def _build_chain_rows(
    config: dict,
    managed_chains: list[str],
    gas_prices_cfg: dict,
    token_prices_cfg: dict,
    scan_data: dict,
) -> list[dict]:
    chains_cfg = config.get("chains", {})
    scan_gas = scan_data.get("gas_prices", {})
    scan_tokens = scan_data.get("token_prices", {})
    sealevel_mode = config.get("igp_submission", {}).get(
        "sealevel_mode", "manual_edit_required"
    )

    rows = []
    for chain in managed_chains:
        cfg = chains_cfg.get(chain, {})
        chain_type = cfg.get("type", "evm")
        current_gas = gas_prices_cfg.get(chain, {})
        if isinstance(current_gas, dict):
            if "amount" in current_gas:
                current_gas_amount = str(current_gas.get("amount"))
                gas_decimals = int(current_gas.get("decimals", 9))
            else:
                current_gas_amount = str(current_gas.get("gasPrice", "0"))
                gas_decimals = int(current_gas.get("decimals", 9))
        else:
            current_gas_amount = str(current_gas)
            gas_decimals = 9

        scan_gas_entry = scan_gas.get(chain, {})
        if chain_type == "sealevel" and sealevel_mode == "manual_edit_required":
            proposed_gas_amount = None
        elif chain_type == "sealevel":
            proposed_gas_amount = str(scan_gas_entry.get("base_fee_lamports", "0"))
            gas_decimals = 1
        else:
            gp_gwei = scan_gas_entry.get("gas_price_gwei")
            if gp_gwei is None:
                gp_wei = scan_gas_entry.get("gas_price_wei")
                gp_gwei = (float(gp_wei) / 1e9) if gp_wei is not None else None
            proposed_gas_amount = (
                _format_number(float(gp_gwei)) if gp_gwei is not None else None
            )
            gas_decimals = 9

        current_token_price = token_prices_cfg.get(chain)
        if isinstance(current_token_price, dict):
            current_token_price = current_token_price.get("tokenPrice")
        current_token_price = (
            str(current_token_price) if current_token_price is not None else None
        )

        native = cfg.get("native")
        usd_price = scan_tokens.get(native, {}).get("usd") if native else None
        proposed_token_price = (
            _format_number(float(usd_price), max_decimals=10)
            if usd_price is not None
            else None
        )

        rows.append(
            {
                "chain": chain,
                "current_gas_amount": current_gas_amount,
                "proposed_gas_amount": proposed_gas_amount,
                "gas_decimals": gas_decimals,
                "current_token_price": current_token_price,
                "proposed_token_price": proposed_token_price,
                "edited_by_user": False,
                "is_sealevel": chain_type == "sealevel",
                "notes": "",
            }
        )
    return rows


def create_proposal(
    config: dict,
    operator: str = "cli",
    managed_chains: list[str] | None = None,
) -> dict:
    if not LATEST_SCAN.exists():
        raise IGPSubmissionError("No latest scan found. Run `python main.py scan` first.")

    monorepo_path = _ensure_managed_monorepo_checkout(config)
    if not monorepo_path.exists():
        raise IGPSubmissionError(f"Monorepo path does not exist: {monorepo_path}")

    scan_data = _load_json(LATEST_SCAN)
    gas_prices_cfg, token_prices_cfg = _read_mainnet3_config_files(monorepo_path)
    supported = _read_mainnet3_supported_chains(monorepo_path)
    managed = _get_managed_chains(config, managed_chains)
    unknown = [c for c in managed if c not in supported]
    if unknown:
        raise IGPSubmissionError(
            f"Managed chains not in mainnet3 supportedChainNames: {unknown}"
        )

    proposal_id = f"igp-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    rows = _build_chain_rows(
        config,
        managed,
        gas_prices_cfg,
        token_prices_cfg,
        scan_data,
    )
    proposal = {
        "proposal_id": proposal_id,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "status": "draft",
        "version": 1,
        "operator": operator,
        "managed_chains": managed,
        "base_scan_timestamp": scan_data.get("timestamp"),
        "base_monorepo_commit": _local_monorepo_commit(monorepo_path),
        "proposal_hash": "",
        "chains": rows,
        "review": {
            "confirmed": False,
            "confirmation_phrase_ok": False,
            "approved_at": None,
            "approved_version": None,
            "final_diff_summary": _compute_diff_summary(rows),
        },
        "submission": {
            "submission_idempotency_key": None,
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
    proposal["proposal_hash"] = _stable_hash(_canonical_submission_payload(proposal))
    _write_json(_proposal_path(proposal_id), proposal)
    return proposal


def load_proposal(proposal_id: str) -> dict:
    path = _proposal_path(proposal_id)
    if not path.exists():
        raise IGPSubmissionError(f"Proposal not found: {proposal_id}")
    return _load_json(path)


def update_proposal(config: dict, proposal_id: str, edits: list[dict], operator: str = "api") -> dict:
    proposal = load_proposal(proposal_id)
    editable = {row["chain"]: row for row in proposal.get("chains", [])}
    for edit in edits:
        chain = edit.get("chain")
        if chain not in editable:
            raise IGPSubmissionError(f"Chain not present in proposal: {chain}")
        row = editable[chain]
        if "proposed_gas_amount" in edit:
            row["proposed_gas_amount"] = edit.get("proposed_gas_amount")
        if "proposed_token_price" in edit:
            row["proposed_token_price"] = edit.get("proposed_token_price")
        if "notes" in edit:
            row["notes"] = edit.get("notes", "")
        row["edited_by_user"] = True

    proposal["version"] = int(proposal.get("version", 1)) + 1
    proposal["status"] = "draft"
    proposal["operator"] = operator
    proposal["updated_at"] = _now_iso()
    proposal["review"] = {
        "confirmed": False,
        "confirmation_phrase_ok": False,
        "approved_at": None,
        "approved_version": None,
        "final_diff_summary": _compute_diff_summary(proposal["chains"]),
    }
    proposal["submission"] = {
        "submission_idempotency_key": None,
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
    }
    proposal["proposal_hash"] = _stable_hash(_canonical_submission_payload(proposal))
    _write_json(_proposal_path(proposal_id), proposal)
    return proposal


def validate_proposal(config: dict, proposal: dict, force: bool = False) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    monorepo_path = _expand_monorepo_path(config)

    if not monorepo_path.exists():
        errors.append(f"Monorepo path does not exist: {monorepo_path}")

    supported = set()
    if not errors:
        try:
            supported = _read_mainnet3_supported_chains(monorepo_path)
        except IGPSubmissionError as exc:
            errors.append(str(exc))

    managed = proposal.get("managed_chains", [])
    for chain in managed:
        if supported and chain not in supported:
            errors.append(f"Managed chain not in mainnet3 supported list: {chain}")

    chains_cfg = config.get("chains", {})
    rows = proposal.get("chains", [])
    sealevel_mode = config.get("igp_submission", {}).get(
        "sealevel_mode", "manual_edit_required"
    )
    max_delta_pct = float(config.get("igp_submission", {}).get("max_delta_pct", 200))

    for row in rows:
        chain = row.get("chain")
        if chain not in managed:
            errors.append(f"Proposal row chain not in managed_chains: {chain}")
            continue

        proposed_gas = row.get("proposed_gas_amount")
        proposed_token = row.get("proposed_token_price")
        current_gas = row.get("current_gas_amount")
        current_token = row.get("current_token_price")
        is_sealevel = bool(row.get("is_sealevel"))

        if is_sealevel and sealevel_mode == "manual_edit_required":
            if proposed_gas in (None, ""):
                errors.append(
                    f"{chain}: proposed_gas_amount required for sealevel chain"
                )

        if proposed_gas not in (None, "") and not _is_number(proposed_gas):
            errors.append(f"{chain}: proposed_gas_amount is not numeric")
        if proposed_token not in (None, "") and not _is_number(proposed_token):
            errors.append(f"{chain}: proposed_token_price is not numeric")

        if (
            proposed_gas not in (None, "")
            and current_gas not in (None, "")
            and _is_number(proposed_gas)
            and _is_number(current_gas)
            and float(current_gas) > 0
        ):
            delta = abs((float(proposed_gas) - float(current_gas)) / float(current_gas))
            if delta * 100 > max_delta_pct and not force:
                errors.append(
                    f"{chain}: gas delta {delta*100:.2f}% exceeds max_delta_pct={max_delta_pct}"
                )
            elif delta * 100 > max_delta_pct:
                warnings.append(
                    f"{chain}: gas delta {delta*100:.2f}% exceeds max_delta_pct but force=true"
                )

        if (
            proposed_token not in (None, "")
            and current_token not in (None, "")
            and _is_number(proposed_token)
            and _is_number(current_token)
            and float(current_token) > 0
        ):
            delta = abs(
                (float(proposed_token) - float(current_token)) / float(current_token)
            )
            if delta * 100 > max_delta_pct and not force:
                errors.append(
                    f"{chain}: token delta {delta*100:.2f}% exceeds max_delta_pct={max_delta_pct}"
                )
            elif delta * 100 > max_delta_pct:
                warnings.append(
                    f"{chain}: token delta {delta*100:.2f}% exceeds max_delta_pct but force=true"
                )

        if chain not in chains_cfg:
            warnings.append(f"{chain}: missing in local config.chains")

    max_age = int(config.get("igp_submission", {}).get("max_proposal_age_minutes", 60))
    base_scan_ts = proposal.get("base_scan_timestamp")
    if isinstance(base_scan_ts, (int, float)):
        age_minutes = (time.time() - float(base_scan_ts)) / 60
        if age_minutes > max_age and not force:
            errors.append(
                f"Proposal is stale ({age_minutes:.1f}m > {max_age}m max_proposal_age_minutes)"
            )
        elif age_minutes > max_age:
            warnings.append(
                f"Proposal is stale ({age_minutes:.1f}m > {max_age}m), allowed with force=true"
            )
    else:
        errors.append("Proposal missing base_scan_timestamp")

    expected_hash = _stable_hash(_canonical_submission_payload(proposal))
    if proposal.get("proposal_hash") != expected_hash:
        errors.append("Proposal hash mismatch; proposal appears mutated without lifecycle update")

    return {"ok": len(errors) == 0, "errors": errors, "warnings": warnings}


def validate_saved_proposal(config: dict, proposal_id: str, force: bool = False) -> dict:
    proposal = load_proposal(proposal_id)
    result = validate_proposal(config, proposal, force=force)
    return {"proposal_id": proposal_id, **result}


def _approve_proposal(
    config: dict,
    proposal: dict,
    confirmation_phrase: str,
    force: bool = False,
) -> dict:
    required = config.get("igp_submission", {}).get(
        "review_requires_phrase", "APPLY IGP UPDATE"
    )
    if confirmation_phrase != required:
        raise IGPSubmissionError("Confirmation phrase mismatch")

    validation = validate_proposal(config, proposal, force=force)
    if not validation["ok"]:
        raise IGPSubmissionError("Proposal validation failed before approval")

    proposal["status"] = "approved"
    proposal["updated_at"] = _now_iso()
    proposal["review"] = {
        "confirmed": True,
        "confirmation_phrase_ok": True,
        "approved_at": _now_iso(),
        "approved_version": proposal.get("version"),
        "final_diff_summary": _compute_diff_summary(proposal.get("chains", [])),
    }
    proposal["submission"]["submission_idempotency_key"] = _stable_hash(
        {
            "proposal_id": proposal.get("proposal_id"),
            "approved_version": proposal["review"]["approved_version"],
            "proposal_hash": proposal.get("proposal_hash"),
        }
    )
    return proposal


def approve_proposal(
    config: dict,
    proposal_id: str,
    confirmation_phrase: str,
    force: bool = False,
) -> dict:
    proposal = load_proposal(proposal_id)
    proposal = _approve_proposal(
        config,
        proposal,
        confirmation_phrase,
        force=force,
    )
    _write_json(_proposal_path(proposal_id), proposal)
    return proposal


def _patch_worktree_json(worktree: Path, proposal: dict) -> tuple[Path, Path]:
    gas_path = worktree / MAINNET3_GAS_PATH
    token_path = worktree / MAINNET3_TOKEN_PATH
    gas_json = _load_json(gas_path)
    token_json = _load_json(token_path)
    managed = set(proposal.get("managed_chains", []))

    for row in proposal.get("chains", []):
        chain = row["chain"]
        if chain not in managed:
            continue
        if row.get("proposed_gas_amount") not in (None, ""):
            gas_json[chain] = {
                "amount": str(row.get("proposed_gas_amount")),
                "decimals": int(row.get("gas_decimals", 9)),
            }
        if row.get("proposed_token_price") not in (None, ""):
            token_json[chain] = str(row.get("proposed_token_price"))

    _write_json(gas_path, gas_json)
    _write_json(token_path, token_json)
    return gas_path, token_path


def _patch_igp_ts_disable_min_floor(worktree: Path, enabled: bool) -> bool:
    if not enabled:
        return False
    igp_ts = worktree / MAINNET3_IGP_TS_PATH
    if not igp_ts.exists():
        raise IGPSubmissionError(f"Missing igp.ts for floor patching: {igp_ts}")

    text = igp_ts.read_text()
    patched, count = re.subn(
        r"(getAllStorageGasOracleConfigs\([\s\S]*?,\s*)(true)(\s*,\s*\)\s*;)",
        r"\1false\3",
        text,
        count=1,
    )
    if count != 1:
        raise IGPSubmissionError(
            "Failed to disable monorepo min-USD floor: expected single boolean arg in mainnet3/igp.ts"
        )
    igp_ts.write_text(patched)
    return True


def _patch_deploy_ts_non_interactive(worktree: Path, backend: str) -> bool:
    if backend != "deploy":
        return False
    deploy_ts = worktree / DEPLOY_TS_PATH
    if not deploy_ts.exists():
        raise IGPSubmissionError(f"Missing deploy.ts for patching: {deploy_ts}")

    text = deploy_ts.read_text()
    patched, count = re.subn(
        r"const \{ value: confirmed \} = await prompts\(\{[\s\S]*?\}\);\n\s*if \(!confirmed\) \{\n\s*process\.exit\(0\);\n\s*\}",
        "const confirmed = true;",
        text,
        count=1,
    )
    if count != 1:
        raise IGPSubmissionError(
            "Failed to patch deploy.ts for non-interactive execution"
        )
    deploy_ts.write_text(patched)
    return True


def _build_submission_command(
    config: dict, managed: list[str], dry_run: bool
) -> tuple[str, list[str], str]:
    backend = _get_submission_backend(config)
    command_cwd_rel = "typescript/infra"

    if backend == "deploy":
        cmd = [
            "pnpm",
            "tsx",
            "scripts/deploy.ts",
            "-e",
            "mainnet3",
            "-m",
            "igp",
            "--chains",
            *managed,
        ]
        if _should_deploy_concurrently(config):
            cmd.append("--concurrentDeploy")
        if dry_run:
            cmd.append("--writePlan")
        return backend, cmd, command_cwd_rel

    cmd = [
        "pnpm",
        "tsx",
        "scripts/check/check-deploy.ts",
        "-e",
        "mainnet3",
        "-m",
        "igp",
        "--chains",
        *managed,
    ]
    if not dry_run:
        cmd.append("--govern")
    return backend, cmd, command_cwd_rel


def _seed_dist_artifacts(monorepo_path: Path, worktree: Path) -> None:
    source_typescript = monorepo_path / "typescript"
    target_typescript = worktree / "typescript"
    if not source_typescript.exists() or not target_typescript.exists():
        return

    for pkg_dir in source_typescript.iterdir():
        if not pkg_dir.is_dir():
            continue
        src_dist = pkg_dir / "dist"
        if not src_dist.exists():
            continue
        dst_dist = target_typescript / pkg_dir.name / "dist"
        dst_dist.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src_dist, dst_dist, dirs_exist_ok=True)


def _run_govern_cmd_with_bootstrap(
    cmd: list[str], cmd_cwd: Path, install_cwd: Path
) -> tuple[int, str, str]:
    run_result = subprocess.run(
        cmd,
        cwd=cmd_cwd,
        capture_output=True,
        text=True,
    )
    stdout = run_result.stdout or ""
    stderr = run_result.stderr or ""
    merged = f"{stdout}\n{stderr}"

    if run_result.returncode == 0 or 'Command "tsx" not found' not in merged:
        return run_result.returncode, stdout, stderr

    install_cmd = ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]
    install_result = subprocess.run(
        install_cmd,
        cwd=install_cwd,
        capture_output=True,
        text=True,
    )
    install_stdout = install_result.stdout or ""
    install_stderr = install_result.stderr or ""
    install_block = (
        "[bootstrap] pnpm install --frozen-lockfile --ignore-scripts\n"
        f"{install_stdout}".strip()
    )
    install_err_block = install_stderr.strip()
    if install_result.returncode != 0:
        final_stdout = "\n".join(filter(None, [stdout.strip(), install_block]))
        final_stderr = "\n".join(filter(None, [stderr.strip(), install_err_block]))
        return install_result.returncode, final_stdout, final_stderr

    retry_result = subprocess.run(
        cmd,
        cwd=cmd_cwd,
        capture_output=True,
        text=True,
    )
    retry_stdout = retry_result.stdout or ""
    retry_stderr = retry_result.stderr or ""
    final_stdout = "\n".join(
        filter(
            None,
            [
                stdout.strip(),
                install_block,
                "[retry] " + " ".join(cmd),
                retry_stdout.strip(),
            ],
        )
    )
    final_stderr = "\n".join(
        filter(None, [stderr.strip(), install_err_block, retry_stderr.strip()])
    )
    return retry_result.returncode, final_stdout, final_stderr


def submit_proposal(
    config: dict,
    proposal_id: str,
    confirmation_phrase: str,
    dry_run: bool = False,
    force: bool = False,
) -> dict:
    proposal = load_proposal(proposal_id)

    if proposal.get("status") == "submitted":
        return {
            "proposal_id": proposal_id,
            "status": "submitted",
            "status_reason": "submitted",
            "message": "Proposal already submitted",
            "submission": proposal.get("submission", {}),
        }

    # Re-approval required if edited after approval.
    approved_version = proposal.get("review", {}).get("approved_version")
    if proposal.get("status") != "approved" or approved_version != proposal.get("version"):
        proposal = _approve_proposal(
            config,
            proposal,
            confirmation_phrase,
            force=force,
        )

    validation = validate_proposal(config, proposal, force=force)
    if not validation["ok"]:
        raise IGPSubmissionError(
            "Proposal validation failed: " + "; ".join(validation["errors"])
        )

    idempotency_key = proposal.get("submission", {}).get("submission_idempotency_key")
    if not idempotency_key:
        idempotency_key = _stable_hash(
            {
                "proposal_id": proposal.get("proposal_id"),
                "approved_version": proposal.get("review", {}).get("approved_version"),
                "proposal_hash": proposal.get("proposal_hash"),
            }
        )
        proposal.setdefault("submission", {})["submission_idempotency_key"] = idempotency_key
    if _idempotency_already_submitted(idempotency_key):
        raise IGPSubmissionError(
            "Submission idempotency key already has a successful submission"
        )

    preflight_warnings = _check_submit_circuit_breaker(config, force=force)

    monorepo_path = _ensure_managed_monorepo_checkout(config)
    managed = proposal.get("managed_chains", [])
    if not managed:
        raise IGPSubmissionError("Proposal has no managed_chains")
    monorepo_commit_at_submit = _local_monorepo_commit(monorepo_path)
    backend, cmd, command_cwd_rel = _build_submission_command(
        config,
        managed,
        dry_run,
    )
    disable_min_floor = _should_disable_monorepo_min_usd_floor(config)
    _validate_monorepo_runtime_artifacts(monorepo_path, backend)

    proposal["status"] = "submitting"
    proposal["updated_at"] = _now_iso()
    proposal.setdefault("submission", {})
    proposal["submission"]["started_at"] = _now_iso()
    proposal["submission"]["dry_run"] = bool(dry_run)
    proposal["submission"]["status_reason"] = None
    proposal["submission"]["preflight_warnings"] = preflight_warnings
    proposal["submission"]["monorepo_commit_at_submit"] = monorepo_commit_at_submit
    proposal["submission"]["base_monorepo_commit_mismatch"] = (
        proposal.get("base_monorepo_commit") != monorepo_commit_at_submit
    )
    proposal["submission"]["backend"] = backend
    proposal["submission"]["disable_monorepo_min_usd_floor"] = disable_min_floor
    proposal["submission"]["floor_patch_applied"] = False
    proposal["submission"]["deploy_prompt_patch_applied"] = False
    _write_json(_proposal_path(proposal_id), proposal)

    tempdir = Path(tempfile.mkdtemp(prefix="igp-submit-"))
    worktree_added = False

    try:
        add_result = subprocess.run(
            [
                "git",
                "-C",
                str(monorepo_path),
                "worktree",
                "add",
                "--detach",
                str(tempdir),
                "HEAD",
            ],
            capture_output=True,
            text=True,
        )
        if add_result.returncode != 0:
            raise IGPSubmissionError(
                "Failed to create monorepo worktree: "
                + (add_result.stderr.strip() or add_result.stdout.strip())
            )
        worktree_added = True

        _patch_worktree_json(tempdir, proposal)
        _seed_dist_artifacts(monorepo_path, tempdir)
        proposal["submission"]["floor_patch_applied"] = _patch_igp_ts_disable_min_floor(
            tempdir,
            disable_min_floor,
        )
        proposal["submission"]["deploy_prompt_patch_applied"] = _patch_deploy_ts_non_interactive(
            tempdir,
            backend,
        )

        command_cwd = tempdir / command_cwd_rel
        if not command_cwd.exists():
            raise IGPSubmissionError(
                f"Missing expected monorepo directory for submit command: {command_cwd}"
            )

        exit_code, stdout, stderr = _run_govern_cmd_with_bootstrap(
            cmd,
            cmd_cwd=command_cwd,
            install_cwd=tempdir,
        )
        artifacts = _parse_result_artifacts(stdout, stderr)
        artifacts["dry_run"] = bool(dry_run)

        proposal["submission"]["command"] = " ".join(cmd)
        proposal["submission"]["command_cwd"] = str(command_cwd)
        proposal["submission"]["exit_code"] = exit_code
        proposal["submission"]["stdout_log"] = stdout
        proposal["submission"]["stderr_log"] = stderr
        proposal["submission"]["result_artifacts"] = artifacts
        proposal["submission"]["completed_at"] = _now_iso()
        proposal["updated_at"] = _now_iso()

        if exit_code == 0 and dry_run:
            proposal["status"] = "aborted"
            proposal["submission"]["status_reason"] = "dry_run_aborted"
        elif exit_code == 0:
            proposal["status"] = "submitted"
            proposal["submission"]["status_reason"] = "submitted"
        else:
            proposal["status"] = "failed"
            proposal["submission"]["status_reason"] = "command_failed"

        _write_json(_proposal_path(proposal_id), proposal)
        _append_audit_log(
            {
                "timestamp": _now_iso(),
                "proposal_id": proposal_id,
                "status": proposal["status"],
                "status_reason": proposal["submission"]["status_reason"],
                "managed_chains": managed,
                "submission_idempotency_key": idempotency_key,
                "dry_run": bool(dry_run),
                "backend": backend,
                "disable_monorepo_min_usd_floor": disable_min_floor,
                "floor_patch_applied": proposal["submission"]["floor_patch_applied"],
                "deploy_prompt_patch_applied": proposal["submission"][
                    "deploy_prompt_patch_applied"
                ],
                "command": proposal["submission"]["command"],
                "command_cwd": proposal["submission"]["command_cwd"],
                "exit_code": proposal["submission"]["exit_code"],
                "monorepo_commit_at_submit": monorepo_commit_at_submit,
                "base_monorepo_commit_mismatch": proposal["submission"][
                    "base_monorepo_commit_mismatch"
                ],
                "preflight_warnings": preflight_warnings,
                "result_artifacts": artifacts,
            }
        )

        return {
            "proposal_id": proposal_id,
            "status": proposal["status"],
            "status_reason": proposal["submission"]["status_reason"],
            "submission": proposal["submission"],
            "validation": validation,
        }
    except Exception:
        proposal["status"] = "failed"
        proposal["updated_at"] = _now_iso()
        proposal["submission"]["completed_at"] = _now_iso()
        proposal["submission"]["status_reason"] = "runtime_exception"
        _write_json(_proposal_path(proposal_id), proposal)
        raise
    finally:
        if worktree_added:
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(monorepo_path),
                    "worktree",
                    "remove",
                    "--force",
                    str(tempdir),
                ],
                capture_output=True,
                text=True,
            )
        if tempdir.exists():
            shutil.rmtree(tempdir, ignore_errors=True)

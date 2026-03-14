"""Create a PR against the upstream monorepo with updated IGP gas/token prices."""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from engine.igp_submission import (
    MAINNET3_GAS_PATH,
    MAINNET3_TOKEN_PATH,
    _get_managed_chains,
)
from engine.monorepo_adapter import (
    GAS_ORACLE_TS_PATH,
    scan_gas_to_monorepo,
    scan_token_to_monorepo,
    compute_floor_overrides,
    patch_gas_oracle_ts,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
LATEST_SCAN = DATA_DIR / "latest_scan.json"

DEFAULT_REPO = "hyperlane-xyz/hyperlane-monorepo"
DEFAULT_DIFF_THRESHOLD_PCT = 5


def _fetch_upstream_file(repo: str, path: str, ref: str = "main") -> dict:
    """Fetch a JSON file from the upstream repo via gh api."""
    raw = _fetch_upstream_text(repo, path, ref)
    return json.loads(raw)


def _fetch_upstream_text(repo: str, path: str, ref: str = "main") -> str:
    """Fetch a raw text file from the upstream repo via gh api."""
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/contents/{path}?ref={ref}"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to fetch {path} from {repo}: {result.stderr.strip()}"
        )
    api_resp = json.loads(result.stdout)
    content_b64 = api_resp.get("content", "")
    return base64.b64decode(content_b64).decode("utf-8")


def _compute_proposed_values(
    config: dict, scan_data: dict, managed_chains: list[str]
) -> tuple[dict, dict]:
    """Compute proposed gas prices and token prices from scan data.

    Returns (gas_updates, token_updates) dicts keyed by chain name.
    gas_updates[chain] = {"amount": str, "decimals": int}
    token_updates[chain] = str (USD price)
    """
    chains_cfg = config.get("chains", {})
    scan_gas = scan_data.get("gas_prices", {})
    scan_tokens = scan_data.get("token_prices", {})

    gas_updates = {}
    token_updates = {}

    for chain in managed_chains:
        cfg = chains_cfg.get(chain, {})
        scan_gas_entry = scan_gas.get(chain, {})

        gas_entry = scan_gas_to_monorepo(cfg, scan_gas_entry)
        if gas_entry is not None:
            gas_updates[chain] = gas_entry

        token_price = scan_token_to_monorepo(cfg, scan_tokens)
        if token_price is not None:
            token_updates[chain] = token_price

    return gas_updates, token_updates


def _has_meaningful_diff(
    current_gas: dict,
    current_tokens: dict,
    gas_updates: dict,
    token_updates: dict,
    threshold_pct: float,
    floor_overrides: dict[str, float] | None = None,
) -> tuple[bool, list[dict]]:
    """Check if proposed values differ meaningfully from current.

    Returns (has_diff, changes_list).
    """
    changes = []

    # Floor overrides are always meaningful (new feature)
    if floor_overrides:
        for chain, floor in floor_overrides.items():
            changes.append({
                "chain": chain,
                "field": "floor",
                "current": None,
                "proposed": f"${floor}",
                "diff_pct": None,
            })

    for chain, proposed in gas_updates.items():
        current = current_gas.get(chain, {})
        current_amount = current.get("amount") if isinstance(current, dict) else None
        proposed_amount = proposed["amount"]

        if current_amount is None:
            changes.append({
                "chain": chain,
                "field": "gas",
                "current": None,
                "proposed": proposed_amount,
                "diff_pct": None,
            })
            continue

        try:
            cur_val = float(current_amount)
            prop_val = float(proposed_amount)
            if cur_val == 0:
                if prop_val != 0:
                    changes.append({
                        "chain": chain,
                        "field": "gas",
                        "current": current_amount,
                        "proposed": proposed_amount,
                        "diff_pct": None,
                    })
                continue
            diff_pct = abs(prop_val - cur_val) / cur_val * 100
            if diff_pct >= threshold_pct:
                changes.append({
                    "chain": chain,
                    "field": "gas",
                    "current": current_amount,
                    "proposed": proposed_amount,
                    "diff_pct": round(diff_pct, 1),
                })
        except (ValueError, TypeError):
            changes.append({
                "chain": chain,
                "field": "gas",
                "current": current_amount,
                "proposed": proposed_amount,
                "diff_pct": None,
            })

    for chain, proposed_price in token_updates.items():
        current_price = current_tokens.get(chain)
        if isinstance(current_price, dict):
            current_price = current_price.get("tokenPrice")
        if current_price is None:
            changes.append({
                "chain": chain,
                "field": "token",
                "current": None,
                "proposed": proposed_price,
                "diff_pct": None,
            })
            continue

        try:
            cur_val = float(str(current_price))
            prop_val = float(proposed_price)
            if cur_val == 0:
                if prop_val != 0:
                    changes.append({
                        "chain": chain,
                        "field": "token",
                        "current": str(current_price),
                        "proposed": proposed_price,
                        "diff_pct": None,
                    })
                continue
            diff_pct = abs(prop_val - cur_val) / cur_val * 100
            if diff_pct >= threshold_pct:
                changes.append({
                    "chain": chain,
                    "field": "token",
                    "current": str(current_price),
                    "proposed": proposed_price,
                    "diff_pct": round(diff_pct, 1),
                })
        except (ValueError, TypeError):
            changes.append({
                "chain": chain,
                "field": "token",
                "current": str(current_price),
                "proposed": proposed_price,
                "diff_pct": None,
            })

    return len(changes) > 0, changes


def _build_pr_body(
    current_gas: dict,
    current_tokens: dict,
    gas_updates: dict,
    token_updates: dict,
    managed_chains: list[str],
    scan_timestamp: float | None,
    floor_overrides: dict[str, float] | None = None,
) -> str:
    """Build the PR description with summary tables."""
    ts_str = "unknown"
    if scan_timestamp:
        ts_str = datetime.fromtimestamp(scan_timestamp, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M UTC"
        )

    lines = [
        "## Summary",
        f"Automated IGP gas/token price update from Fee Autopilot scan ({ts_str}).",
        "",
        "### Gas Prices (gasPrices.json)",
        "| Chain | Current | Proposed |",
        "|-------|---------|----------|",
    ]

    for chain in managed_chains:
        if chain in gas_updates:
            cur = current_gas.get(chain, {})
            cur_amount = cur.get("amount") if isinstance(cur, dict) else str(cur) if cur else "—"
            prop_amount = gas_updates[chain]["amount"]
            decimals = gas_updates[chain]["decimals"]
            unit = "gwei" if decimals == 9 else f"(decimals={decimals})"
            lines.append(f"| {chain} | {cur_amount} {unit} | {prop_amount} {unit} |")

    lines.extend([
        "",
        "### Token Prices (tokenPrices.json)",
        "| Chain | Current | Proposed |",
        "|-------|---------|----------|",
    ])

    for chain in managed_chains:
        if chain in token_updates:
            cur_price = current_tokens.get(chain)
            if isinstance(cur_price, dict):
                cur_price = cur_price.get("tokenPrice")
            cur_str = f"${cur_price}" if cur_price else "—"
            prop_str = f"${token_updates[chain]}"
            lines.append(f"| {chain} | {cur_str} | {prop_str} |")

    if floor_overrides:
        lines.extend([
            "",
            "### Min-Cost Floor Overrides (gas-oracle.ts)",
            "",
            "Sets per-chain `remoteMinCostOverrides` to match our computed delivery costs "
            "(raw cost + 50% margin). Also changes `Math.max(minUsdCost, override)` to "
            "`minUsdCost = override` so overrides can lower the default $0.20/$0.50 floors.",
            "",
            "| Chain | Floor (USD) |",
            "|-------|-------------|",
        ])
        for chain in managed_chains:
            if chain in floor_overrides:
                lines.append(f"| {chain} | ${floor_overrides[chain]} |")

    lines.extend([
        "",
        "Generated by Hyperlane Fee Autopilot",
    ])

    return "\n".join(lines)


def _run(cmd: list[str], cwd: str | Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed: {' '.join(cmd)}\n"
            f"stderr: {result.stderr.strip()}\nstdout: {result.stdout.strip()}"
        )
    return result


def _forward_verify(
    gas_updates: dict,
    token_updates: dict,
    floor_overrides: dict[str, float],
    chains_config: dict,
    scan_data: dict,
) -> list[str]:
    """Verify that on-chain IGP quotes will exceed floor overrides.

    For each chain, compute:
      quote_usd = amount * remoteTokenPrice * 1.5 * (gas_overhead + handle_gas) / 1e9
    and confirm quote_usd >= floor_override.

    Returns list of verification lines for display.
    """
    lines = []
    scan_tokens = scan_data.get("token_prices", {})

    for chain, floor in sorted(floor_overrides.items()):
        cfg = chains_config.get(chain, {})
        chain_type = cfg.get("type", "evm")
        gas_overhead = cfg.get("gas_overhead", 217000)
        handle_gas = 300_000 if chain_type == "sealevel" else 50_000
        total_gas = gas_overhead + handle_gas

        gas_entry = gas_updates.get(chain)
        token_price_str = token_updates.get(chain)
        native_key = cfg.get("native", "ethereum")
        native_price = scan_tokens.get(native_key, {}).get("usd")

        if not gas_entry or not token_price_str or not native_price:
            lines.append(f"  {chain}: SKIP (missing data)")
            continue

        amount = float(gas_entry["amount"])
        decimals = gas_entry["decimals"]
        remote_token_price = float(token_price_str)

        # EVM: amount is in gwei, decimals=9 → amount/1e9 = gas price in ETH
        #   cost_eth = (amount/1e9) * total_gas → cost_usd = cost_eth * native_price
        # Sealevel: amount is lamports_per_CU * 10, decimals=1 → amount/10 = lamports/CU
        #   cost_lamports = (amount/10) * total_gas → cost_native = cost_lamports / 1e9
        gas_price_per_unit = amount / (10 ** decimals)
        if chain_type == "sealevel":
            # gas_price_per_unit is lamports per CU
            quote_native = gas_price_per_unit * total_gas / 1e9
        else:
            # gas_price_per_unit is in ETH (gwei converted)
            quote_native = gas_price_per_unit * total_gas

        quote_usd = quote_native * float(native_price) * 1.5  # 50% margin
        status = "OK" if quote_usd >= floor else "WARN"
        lines.append(
            f"  {chain}: quote=${quote_usd:.4f} vs floor=${floor:.2f} [{status}]"
        )

    return lines


def generate_igp_pr(
    config: dict,
    scan_data: dict,
    dry_run: bool = False,
    repo: str = DEFAULT_REPO,
) -> dict:
    """Generate a PR with updated IGP gas/token prices and floor overrides.

    Returns a dict with keys: pr_url, branch, changes, pr_body, dry_run.
    """
    managed_chains = _get_managed_chains(config)
    chains_cfg = config.get("chains", {})
    threshold_pct = float(
        config.get("pricing", {}).get("igp", {}).get(
            "diff_threshold_pct", DEFAULT_DIFF_THRESHOLD_PCT
        )
    )

    # 1. Fetch current upstream files
    print("Fetching current upstream config files...")
    current_gas = _fetch_upstream_file(repo, MAINNET3_GAS_PATH)
    current_tokens = _fetch_upstream_file(repo, MAINNET3_TOKEN_PATH)
    current_gas_oracle_ts = _fetch_upstream_text(repo, GAS_ORACLE_TS_PATH)

    # 2. Compute proposed values from scan data
    gas_updates, token_updates = _compute_proposed_values(
        config, scan_data, managed_chains
    )

    # 3. Compute floor overrides from delivery costs
    delivery_costs = scan_data.get("delivery_costs", {})
    floor_overrides = compute_floor_overrides(chains_cfg, delivery_costs, managed_chains)

    # 4. Check for meaningful differences
    has_diff, changes = _has_meaningful_diff(
        current_gas, current_tokens, gas_updates, token_updates,
        threshold_pct, floor_overrides,
    )

    if not has_diff:
        return {
            "pr_url": None,
            "branch": None,
            "changes": [],
            "pr_body": None,
            "dry_run": dry_run,
            "message": f"No meaningful changes (threshold={threshold_pct}%)",
        }

    # 5. Build patched JSON files (only update managed chain keys)
    patched_gas = dict(current_gas)
    for chain, update in gas_updates.items():
        patched_gas[chain] = {
            "amount": update["amount"],
            "decimals": update["decimals"],
        }

    patched_tokens = dict(current_tokens)
    for chain, price in token_updates.items():
        patched_tokens[chain] = price

    # 6. Patch gas-oracle.ts
    patched_gas_oracle_ts = patch_gas_oracle_ts(current_gas_oracle_ts, floor_overrides)

    # 7. Build PR body
    scan_ts = scan_data.get("timestamp")
    pr_body = _build_pr_body(
        current_gas, current_tokens, gas_updates, token_updates,
        managed_chains, scan_ts, floor_overrides,
    )

    ts_str = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    branch_name = f"fee-autopilot/igp-update-{ts_str}"

    if dry_run:
        print(f"\n=== DRY RUN — would create branch: {branch_name} ===\n")
        print("Gas price changes:")
        for c in changes:
            if c["field"] == "gas":
                diff = f" ({c['diff_pct']}%)" if c["diff_pct"] else ""
                print(f"  {c['chain']}: {c['current']} → {c['proposed']}{diff}")
        print("\nToken price changes:")
        for c in changes:
            if c["field"] == "token":
                diff = f" ({c['diff_pct']}%)" if c["diff_pct"] else ""
                print(f"  {c['chain']}: {c['current']} → {c['proposed']}{diff}")

        if floor_overrides:
            print("\nFloor overrides (gas-oracle.ts remoteMinCostOverrides):")
            for chain in managed_chains:
                if chain in floor_overrides:
                    print(f"  {chain}: ${floor_overrides[chain]}")
            print("  Math.max(minUsdCost, override) → minUsdCost = override")

            print("\nForward verification (quote >= floor):")
            verify_lines = _forward_verify(
                gas_updates, token_updates, floor_overrides, chains_cfg, scan_data
            )
            for line in verify_lines:
                print(line)

        print(f"\n--- PR Body ---\n{pr_body}\n")
        return {
            "pr_url": None,
            "branch": branch_name,
            "changes": changes,
            "pr_body": pr_body,
            "dry_run": True,
            "floor_overrides": floor_overrides,
            "message": f"Dry run complete. {len(changes)} changes detected.",
        }

    # 8. Clone, branch, commit, push, create PR
    tmpdir = tempfile.mkdtemp(prefix="igp-pr-")
    clone_path = Path(tmpdir) / "monorepo"
    try:
        print(f"Cloning {repo} (shallow)...")
        _run(["gh", "repo", "clone", repo, str(clone_path), "--", "--depth", "1"])

        print(f"Creating branch {branch_name}...")
        _run(["git", "checkout", "-b", branch_name], cwd=clone_path)

        # Write patched files
        gas_path = clone_path / MAINNET3_GAS_PATH
        token_path = clone_path / MAINNET3_TOKEN_PATH
        gas_oracle_path = clone_path / GAS_ORACLE_TS_PATH

        with open(gas_path, "w") as f:
            json.dump(patched_gas, f, indent=2, sort_keys=False)
            f.write("\n")

        with open(token_path, "w") as f:
            json.dump(patched_tokens, f, indent=2, sort_keys=False)
            f.write("\n")

        with open(gas_oracle_path, "w") as f:
            f.write(patched_gas_oracle_ts)

        # Commit
        _run(
            ["git", "add", MAINNET3_GAS_PATH, MAINNET3_TOKEN_PATH, GAS_ORACLE_TS_PATH],
            cwd=clone_path,
        )
        commit_msg = f"Update IGP gas/token prices and floor overrides ({ts_str})"
        _run(["git", "commit", "-m", commit_msg], cwd=clone_path)

        # Push
        print("Pushing branch...")
        _run(["git", "push", "-u", "origin", branch_name], cwd=clone_path)

        # Create PR
        print("Creating pull request...")
        pr_title = f"Update IGP gas/token prices + floor overrides ({ts_str})"
        pr_result = _run(
            [
                "gh", "pr", "create",
                "--repo", repo,
                "--title", pr_title,
                "--body", pr_body,
                "--head", branch_name,
                "--base", "main",
            ],
            cwd=clone_path,
        )
        pr_url = pr_result.stdout.strip()

        return {
            "pr_url": pr_url,
            "branch": branch_name,
            "changes": changes,
            "pr_body": pr_body,
            "dry_run": False,
            "floor_overrides": floor_overrides,
            "message": f"PR created: {pr_url}",
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

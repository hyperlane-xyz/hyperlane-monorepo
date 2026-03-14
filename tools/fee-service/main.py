#!/usr/bin/env python3
"""Hyperlane Fee Autopilot — CLI entry point.

Commands:
    scan        Collect all data (gas, tokens, competitors, Hyperlane state)
    report      Generate HTML dashboard from latest scan
    recommend   Generate fee recommendations with safety checks
    apply       Write updated gasPrices.json / tokenPrices.json files
    igp-review  Create/edit/approve an IGP submission proposal
    igp-validate Validate an IGP submission proposal
    igp-submit  Submit an approved IGP proposal via monorepo backend
    igp-execute Create + submit in one command (agent convenience)
    igp-pr      Create a PR to update IGP gas/token prices in the monorepo
    serve       Start the live web dashboard

Examples:
    python main.py scan                    # Full scan (includes competitor quotes)
    python main.py scan --no-competitors   # Skip competitors (explicit opt-out)
    python main.py report                  # Generate dashboard
    python main.py recommend               # Generate recommendations
    python main.py serve                   # Start live dashboard at http://localhost:5001
    python main.py serve --port 8080       # Custom port
    python main.py scan && python main.py report  # Full pipeline
"""

import argparse
import json
import os
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median

import yaml

# Add project root to path
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

from collectors.gas_prices import GasPriceCollector
from collectors.token_prices import TokenPriceCollector
from collectors.competitors import CompetitorCollector
from collectors.hyperlane_state import HyperlaneStateCollector
from collectors.rebalancing import RebalancingCollector
from engine.cost_model import compute_all_delivery_costs, compute_igp_params
from engine.competitive import competitive_summary
from engine.rebalancing import RebalancingCostProvider
from engine.recommender import (
    recommend_all_warp_fees,
    recommend_all_igp_updates,
)
from engine.safety import SafetyChecker
from engine.igp_submission import (
    IGPSubmissionError,
    approve_proposal,
    create_proposal,
    load_proposal,
    submit_proposal,
    update_proposal,
    validate_saved_proposal,
)
from engine.igp_pr import generate_igp_pr
from output.dashboard import generate_dashboard
from output.alerts import (
    send_slack_alert,
    format_igp_drift_alert,
    format_safety_alert,
    format_competitive_alert,
    format_stale_data_alert,
)
from output.updater import write_update_files
from storage.history import (
    save_gas_prices,
    save_token_prices,
    save_competitor_quotes,
    save_recommendations,
    save_scan_snapshot,
)


DATA_DIR = PROJECT_ROOT / "data"
REPORTS_DIR = DATA_DIR / "reports"
SNAPSHOTS_DIR = DATA_DIR / "snapshots"
LATEST_SCAN = DATA_DIR / "latest_scan.json"


def load_config() -> dict:
    config_path = PROJECT_ROOT / "config" / "system.yaml"
    with open(config_path) as f:
        config = yaml.safe_load(f)

    # Resolve env vars in config (e.g., ${SLACK_WEBHOOK_URL}, ${SLACK_BOT_TOKEN})
    for section_name in ("alerts", "slack"):
        section = config.get(section_name, {})
        for key, val in section.items():
            if isinstance(val, str) and val.startswith("${") and val.endswith("}"):
                env_var = val[2:-1]
                section[key] = os.environ.get(env_var, "")

    # Resolve env vars in chain configs (e.g., ${HELIUS_RPC_URL})
    for chain_cfg in config.get("chains", {}).values():
        for key, val in chain_cfg.items():
            if isinstance(val, str) and val.startswith("${") and val.endswith("}"):
                env_var = val[2:-1]
                chain_cfg[key] = os.environ.get(env_var, "")

    return config


def _load_json_file(path: str | Path) -> dict:
    with open(path) as f:
        return json.load(f)


def _write_json_file(path: Path, payload: dict) -> None:
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


def _proposal_id_from_ref(ref: str) -> str:
    p = Path(ref)
    if p.suffix == ".json":
        return p.stem
    return ref


def _parse_edit_specs(edit_specs: list[str]) -> list[dict]:
    edits = []
    for raw in edit_specs:
        # Format: chain:gas:token (gas/token can be empty for partial update)
        parts = raw.split(":", 2)
        if len(parts) != 3:
            raise IGPSubmissionError(
                f"Invalid --edit format `{raw}`. Expected `chain:gas:token`."
            )
        chain, gas, token = parts
        if not chain:
            raise IGPSubmissionError(f"Invalid --edit entry `{raw}` (missing chain)")
        entry = {"chain": chain}
        if gas != "":
            entry["proposed_gas_amount"] = gas
        if token != "":
            entry["proposed_token_price"] = token
        edits.append(entry)
    return edits


def compute_igp_quote_comparison(live_warp_fees: dict, delivery_costs: dict,
                                 chains_config: dict, tokens_config: dict,
                                 token_prices: dict) -> dict:
    """Compare on-chain IGP quote USD vs recommended IGP quote USD.

    Current quote source:
      - quoteGasPayment(domain) from each on-chain warp route (origin chain native token)
    Recommended quote source:
      - delivery_costs[destination]["igp_quote_usd"]
    """
    routes = {}
    by_destination_acc = {}

    for route_key, data in live_warp_fees.items():
        origin = data.get("origin")
        destination = data.get("destination")
        igp_quote_raw = data.get("igp_quote_wei")
        if not origin or not destination or not igp_quote_raw:
            continue

        origin_cfg = chains_config.get(origin, {})
        native_token = origin_cfg.get("native")
        if not native_token:
            continue

        native_price = token_prices.get(native_token, {}).get("usd")
        if native_price is None:
            continue

        token_meta = tokens_config.get(native_token, {})
        native_decimals = token_meta.get("decimals")
        if native_decimals is None:
            native_decimals = 9 if origin_cfg.get("type") == "sealevel" else 18

        try:
            quote_usd = (int(igp_quote_raw) / (10 ** int(native_decimals))) * float(native_price)
        except (TypeError, ValueError, ZeroDivisionError):
            continue

        rec_usd = delivery_costs.get(destination, {}).get("igp_quote_usd")
        delta_usd = (rec_usd - quote_usd) if rec_usd is not None else None

        route_summary = {
            "origin": origin,
            "destination": destination,
            "current_quote_usd": round(quote_usd, 6),
            "recommended_usd": round(rec_usd, 6) if rec_usd is not None else None,
            "delta_usd": round(delta_usd, 6) if delta_usd is not None else None,
            "native_token": native_token,
            "native_token_price_usd": round(float(native_price), 6),
            "native_token_decimals": int(native_decimals),
        }
        routes[route_key] = route_summary

        by_destination_acc.setdefault(destination, []).append(route_summary)

    by_destination = {}
    for destination, entries in by_destination_acc.items():
        current_vals = [e["current_quote_usd"] for e in entries]
        rec_vals = [e["recommended_usd"] for e in entries if e.get("recommended_usd") is not None]
        delta_vals = [e["delta_usd"] for e in entries if e.get("delta_usd") is not None]

        summary = {
            "n_routes": len(entries),
            "current_median_usd": round(float(median(current_vals)), 6),
            "current_avg_usd": round(float(mean(current_vals)), 6),
        }
        if rec_vals:
            summary["recommended_usd"] = round(float(rec_vals[0]), 6)
        if delta_vals:
            summary["delta_median_usd"] = round(float(median(delta_vals)), 6)
            summary["delta_avg_usd"] = round(float(mean(delta_vals)), 6)
        by_destination[destination] = summary

    return {
        "n_routes_compared": len(routes),
        "routes": routes,
        "by_destination": by_destination,
    }


def cmd_scan(args, config):
    """Collect all data sources."""
    print("=== Hyperlane Fee Autopilot — Scanning ===\n")
    scan_start = time.time()
    scan_data = {"timestamp": time.time()}
    timestamps = {}

    # 1. Gas prices
    print("[1/6] Fetching gas prices...")
    gas_collector = GasPriceCollector(config)
    gas_data = gas_collector.collect()
    scan_data["gas_prices"] = gas_data
    timestamps["gas_prices"] = time.time()
    for chain, data in gas_data.items():
        if data.get("type") == "sealevel":
            print(f"  {chain}: {data.get('base_fee_lamports')} lamports "
                  f"+ {data.get('priority_fee_microlamports')} μlamports priority")
        else:
            print(f"  {chain}: {data.get('gas_price_gwei', 0):.2f} gwei")

    # 2. Token prices
    print("\n[2/6] Fetching token prices...")
    token_collector = TokenPriceCollector(config)
    token_prices = token_collector.collect()
    scan_data["token_prices"] = token_prices
    timestamps["token_prices"] = time.time()
    for token, data in token_prices.items():
        print(f"  {token}: ${data.get('usd', 0):,.2f} ({data.get('source', '')})")

    # 3. Hyperlane current state (on-chain fees)
    print("\n[3/6] Reading Hyperlane on-chain fees...")
    hl_collector = HyperlaneStateCollector(config, args.monorepo)
    hl_state = hl_collector.collect()
    scan_data["hyperlane_state"] = hl_state
    timestamps["hyperlane_state"] = time.time()
    n_gas = len(hl_state.get("igp", {}).get("gas_prices", {}))
    n_token = len(hl_state.get("igp", {}).get("token_prices", {}))
    if n_gas or n_token:
        print(f"  IGP: {n_gas} gas prices, {n_token} token prices loaded")
    warp_fees = hl_state.get("warp_fees", {})
    if warp_fees:
        # Summarize by unique fee levels at $1K
        fee_levels = {}
        for route_key, data in warp_fees.items():
            bps = data.get("fees_by_amount", {}).get(1000, {}).get("fee_bps")
            if bps is None:
                bps = data.get("fees_by_amount", {}).get("1000", {}).get("fee_bps")
            if bps is not None:
                fee_levels.setdefault(bps, []).append(route_key)
        for bps in sorted(fee_levels.keys(), reverse=True):
            routes = fee_levels[bps]
            print(f"  Warp fee {bps:.1f} bps: {len(routes)} routes")
        print(f"  Total: {len(warp_fees)} route fees read on-chain")
    else:
        print("  No warp fee data (cast not available or no warp_addresses configured)")

    # 4. Delivery costs
    print("\n[4/6] Computing delivery costs...")
    igp_config = config.get("pricing", {}).get("igp", {})
    delivery_costs = compute_all_delivery_costs(
        config["chains"], gas_data, token_prices, igp_config
    )
    scan_data["delivery_costs"] = delivery_costs
    for chain, cost in delivery_costs.items():
        if cost.get("raw_cost_usd") is not None:
            raw = cost['raw_cost_usd']
            igp = cost.get('igp_quote_usd', raw)
            flag = " (min floor)" if cost.get("min_usd_applied") else ""
            print(f"  {chain}: raw=${raw:.4f}, IGP=${igp:.4f}{flag}")
        else:
            print(f"  {chain}: ERROR — {cost.get('error', 'unknown')}")

    # Compare current on-chain IGP quotes (quoteGasPayment) vs recommendations in USD
    igp_quote_comparison = compute_igp_quote_comparison(
        warp_fees,
        delivery_costs,
        config.get("chains", {}),
        config.get("tokens", {}),
        token_prices,
    )
    scan_data["igp_quote_comparison"] = igp_quote_comparison

    # 5. Competitor quotes
    competitor_quotes = {}
    if not args.no_competitors:
        print("\n[5/6] Fetching competitor quotes (this takes a minute)...")
        comp_collector = CompetitorCollector(config)
        competitor_quotes = comp_collector.collect(config["routes"], token_prices)
        scan_data["competitor_quotes"] = competitor_quotes
        scan_data["competitor_collection_stats"] = comp_collector.get_collection_stats()
        timestamps["competitors"] = time.time()
        n_routes = len(competitor_quotes)
        n_quotes = sum(len(v) for v in competitor_quotes.values())
        print(f"  {n_routes} routes, {n_quotes} competitor quotes collected")
    else:
        print("\n[5/6] Skipping competitor quotes (--no-competitors set)")
        scan_data["competitor_quotes"] = {}

    # 6. Rebalancing costs
    rebal_provider = None
    if config.get("rebalancing", {}).get("addresses"):
        print("\n[6/6] Collecting rebalancing costs...")
        try:
            rebal_collector = RebalancingCollector(config)
            rebal_data = rebal_collector.collect(token_prices)
            scan_data["rebalancing"] = rebal_data

            rebal_provider = RebalancingCostProvider(config)
            rebal_provider.update_from_tx_data(rebal_data)
            scan_data["rebalancing_costs"] = rebal_provider.get_all_costs()
            timestamps["rebalancing"] = time.time()

            n_txs = rebal_data["summary"]["total_txs"]
            total_gas = rebal_data["summary"]["total_gas_cost_usd"]
            print(f"  {n_txs} rebalancing txs, ${total_gas:.2f} total gas cost")
            for chain, cost in rebal_provider.get_all_costs().items():
                if isinstance(cost, dict):
                    print(f"  {chain}: {cost.get('bps', 0):.2f} bps ({cost.get('source', '')})")
        except Exception as e:
            print(f"  Rebalancing collection failed: {e}")
            scan_data["rebalancing"] = {"error": str(e)}
    else:
        print("\n[6/6] No rebalancing addresses configured")

    # Live on-chain warp fees (read in step 3)
    live_warp_fees = hl_state.get("warp_fees", {})

    # Compute competitive summary (with live warp fees for all-in positioning)
    comp_summary = competitive_summary(
        competitor_quotes, delivery_costs, config["chains"], live_warp_fees
    )
    scan_data["competitive_summary"] = comp_summary

    # IGP recommendations
    igp_recs = recommend_all_igp_updates(
        config["chains"], gas_data, token_prices, igp_config, hl_state
    )
    scan_data["igp_recommendations"] = igp_recs

    # Warp recommendations (with live on-chain fees + rebalancing costs)
    warp_config = config.get("pricing", {}).get("warp", {})
    warp_recs = recommend_all_warp_fees(
        config["routes"], delivery_costs, competitor_quotes,
        warp_config, config["chains"], live_warp_fees,
        rebalancing_provider=rebal_provider,
    )
    scan_data["warp_recommendations"] = warp_recs

    # Safety checks
    safety = SafetyChecker(config)
    circuit_breaker = safety.check_circuit_breakers(
        {"gas": gas_data, "tokens": token_prices}, token_prices
    )
    stale = safety.check_staleness(timestamps)
    scan_data["safety"] = {
        "circuit_breaker": circuit_breaker,
        "stale_sources": stale,
    }

    # Persist
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LATEST_SCAN, "w") as f:
        json.dump(scan_data, f, indent=2, default=str)

    save_gas_prices(gas_data)
    save_token_prices(token_prices)
    if competitor_quotes:
        save_competitor_quotes(competitor_quotes)

    snapshot_path = save_scan_snapshot(scan_data)

    elapsed = time.time() - scan_start
    print(f"\nScan complete in {elapsed:.1f}s")
    print(f"  Snapshot: {snapshot_path}")
    print(f"  Latest:   {LATEST_SCAN}")

    # Count IGP updates needed
    n_updates = sum(1 for r in igp_recs.values() if r.get("needs_update"))
    if n_updates:
        print(f"\n  {n_updates} IGP routes need parameter updates")
    else:
        print("\n  IGP params within threshold (no gas/token oracle updates flagged)")

    igp_cmp = scan_data.get("igp_quote_comparison", {})
    n_compared = igp_cmp.get("n_routes_compared", 0)
    by_dest = igp_cmp.get("by_destination", {})
    if n_compared and by_dest:
        print(f"\n  Current on-chain IGP quote vs recommended (USD) across {n_compared} routes:")
        for destination in sorted(by_dest.keys()):
            summary = by_dest[destination]
            cur = summary.get("current_median_usd")
            rec = summary.get("recommended_usd")
            delta = summary.get("delta_median_usd")
            if cur is None or rec is None or delta is None:
                continue
            print(
                f"    {destination}: current median=${cur:.4f}, "
                f"rec=${rec:.4f}, delta={delta:+.4f}"
            )

    if circuit_breaker.get("halt"):
        print(f"\n  CIRCUIT BREAKER: {circuit_breaker['issues']}")

    return scan_data


def cmd_report(args, config):
    """Generate HTML dashboard."""
    if not LATEST_SCAN.exists():
        print("No scan data found. Run 'scan' first.")
        sys.exit(1)

    with open(LATEST_SCAN) as f:
        scan_data = json.load(f)

    print("Generating dashboard...")
    html = generate_dashboard(scan_data)

    os.makedirs(REPORTS_DIR, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_path = REPORTS_DIR / f"dashboard_{ts}.html"
    with open(report_path, "w") as f:
        f.write(html)

    # Also write latest
    latest_path = REPORTS_DIR / "dashboard_latest.html"
    with open(latest_path, "w") as f:
        f.write(html)

    print(f"Dashboard: {report_path} ({len(html):,} bytes)")
    print(f"Latest:    {latest_path}")

    if not args.no_open:
        webbrowser.open(f"file://{latest_path}")

    return str(report_path)


def cmd_recommend(args, config):
    """Generate and display recommendations."""
    if not LATEST_SCAN.exists():
        print("No scan data found. Run 'scan' first.")
        sys.exit(1)

    with open(LATEST_SCAN) as f:
        scan_data = json.load(f)

    igp_recs = scan_data.get("igp_recommendations", {})
    warp_recs = scan_data.get("warp_recommendations", {})

    print("=== IGP Recommendations ===\n")
    n_updates = 0
    for route, rec in sorted(igp_recs.items()):
        if rec.get("needs_update"):
            n_updates += 1
            gas_diff = rec.get("gas_price_diff_pct", 0) or 0
            token_diff = rec.get("token_price_diff_pct", 0) or 0
            print(f"  {route}: gas {gas_diff:+.1f}%, token {token_diff:+.1f}%")

    if n_updates == 0:
        print("  All IGP parameters within threshold. No updates needed.")
    else:
        print(f"\n  {n_updates} routes need updates")

    print("\n=== Warp Fee Recommendations ===\n")
    for route, rec in sorted(warp_recs.items()):
        if rec.get("error"):
            continue
        bps = rec.get("recommended_bps", 0)
        rationale = rec.get("rationale", "")
        print(f"  {route}: {bps:.1f} bps — {rationale}")

    # Save recommendations
    save_recommendations(igp_recs, "igp")
    save_recommendations(warp_recs, "warp")

    # Send Slack alerts if configured
    if args.alert:
        _send_alerts(scan_data, config)


def cmd_apply(args, config):
    """Generate updated JSON files for IGP and warp fees."""
    if not LATEST_SCAN.exists():
        print("No scan data found. Run 'scan' first.")
        sys.exit(1)

    with open(LATEST_SCAN) as f:
        scan_data = json.load(f)

    igp_recs = scan_data.get("igp_recommendations", {})
    warp_recs = scan_data.get("warp_recommendations", {})

    # Safety check
    safety = SafetyChecker(config)
    cb = safety.check_circuit_breakers(
        {"gas": scan_data.get("gas_prices", {}),
         "tokens": scan_data.get("token_prices", {})},
        scan_data.get("token_prices", {}),
    )
    if cb.get("halt") and not args.force:
        print("CIRCUIT BREAKER ACTIVE — cannot apply updates.")
        print(f"Issues: {cb['issues']}")
        print("Use --force to override (dangerous)")
        sys.exit(1)

    output_dir = str(DATA_DIR / "updates")
    result = write_update_files(igp_recs, warp_recs, config["chains"], output_dir)

    print(f"\n{result['summary']}")
    for f in result["files_written"]:
        print(f"  {f}")

def cmd_igp_review(args, config):
    """Create/edit/approve an IGP submission proposal."""
    try:
        if args.proposal:
            proposal_id = _proposal_id_from_ref(args.proposal)
            proposal = load_proposal(proposal_id)
        else:
            proposal = create_proposal(
                config,
                operator="cli",
                managed_chains=args.managed_chain,
            )
            proposal_id = proposal["proposal_id"]

        if args.edit:
            edits = _parse_edit_specs(args.edit)
            proposal = update_proposal(
                config,
                proposal_id,
                edits,
                operator="cli",
            )

        if args.approve:
            if not args.confirmation_phrase:
                raise IGPSubmissionError(
                    "--approve requires --confirmation-phrase"
                )
            proposal = approve_proposal(
                config,
                proposal_id,
                args.confirmation_phrase,
                force=args.force,
            )

        proposal_path = DATA_DIR / "igp_proposals" / f"{proposal_id}.json"
        print(f"Proposal: {proposal_id}")
        print(f"Status:   {proposal.get('status')}")
        print(f"Version:  {proposal.get('version')}")
        print(f"Path:     {proposal_path}")
        print(f"Summary:  {proposal.get('review', {}).get('final_diff_summary')}")
    except IGPSubmissionError as e:
        print(f"IGP review failed: {e}")
        sys.exit(1)


def cmd_igp_validate(args, config):
    """Validate an IGP submission proposal."""
    try:
        proposal_id = _proposal_id_from_ref(args.proposal)
        result = validate_saved_proposal(config, proposal_id, force=args.force)
        print(f"Proposal: {proposal_id}")
        print(f"Valid:    {result['ok']}")
        if result["warnings"]:
            print("Warnings:")
            for w in result["warnings"]:
                print(f"  - {w}")
        if result["errors"]:
            print("Errors:")
            for err in result["errors"]:
                print(f"  - {err}")
        if not result["ok"]:
            sys.exit(1)
    except IGPSubmissionError as e:
        print(f"IGP validate failed: {e}")
        sys.exit(1)


def cmd_igp_submit(args, config):
    """Submit an approved IGP proposal via configured monorepo backend."""
    try:
        proposal_id = _proposal_id_from_ref(args.proposal)
        result = submit_proposal(
            config,
            proposal_id,
            confirmation_phrase=args.confirmation_phrase,
            dry_run=args.dry_run,
            force=args.force,
        )
        status = result.get("status")
        status_reason = result.get("status_reason")
        display_status = "aborted (dry-run)" if status == "aborted" else status
        print(f"Proposal: {proposal_id}")
        print(f"Status:   {display_status}")
        if status_reason:
            print(f"Reason:   {status_reason}")
        submission = result.get("submission", {})
        if submission.get("backend"):
            print(f"Backend:  {submission.get('backend')}")
        if submission.get("disable_monorepo_min_usd_floor") is not None:
            print(
                "NoFloor:  "
                f"enabled={submission.get('disable_monorepo_min_usd_floor')}, "
                f"patched={submission.get('floor_patch_applied')}"
            )
        print(f"Exit:     {submission.get('exit_code')}")
        artifacts = (submission.get("result_artifacts") or {})
        if artifacts:
            print("Artifacts:")
            print(f"  signer_tx_hashes: {len(artifacts.get('signer_tx_hashes', []))}")
            print(f"  safe_tx_hashes:   {len(artifacts.get('safe_tx_hashes', []))}")
            print(f"  manual_payloads:  {len(artifacts.get('manual_payloads', []))}")
        if status not in {"submitted", "aborted"}:
            sys.exit(1)
    except IGPSubmissionError as e:
        print(f"IGP submit failed: {e}")
        sys.exit(1)


def cmd_igp_execute(args, config):
    """Create + optionally edit + submit an IGP proposal in one flow."""
    try:
        proposal = create_proposal(
            config,
            operator="cli",
            managed_chains=args.managed_chain,
        )
        proposal_id = proposal["proposal_id"]

        if args.edit:
            edits = _parse_edit_specs(args.edit)
            update_proposal(config, proposal_id, edits, operator="cli")

        result = submit_proposal(
            config,
            proposal_id,
            confirmation_phrase=args.confirmation_phrase,
            dry_run=args.dry_run,
            force=args.force,
        )
        status = result.get("status")
        display_status = "aborted (dry-run)" if status == "aborted" else status
        print(f"Proposal: {proposal_id}")
        print(f"Status:   {display_status}")
        print(f"Dry run:  {args.dry_run}")
        submission = result.get("submission", {})
        if submission.get("backend"):
            print(f"Backend:  {submission.get('backend')}")
        print(f"Result:   {display_status}")
        if status not in {"submitted", "aborted"}:
            sys.exit(1)
    except IGPSubmissionError as e:
        print(f"IGP execute failed: {e}")
        sys.exit(1)


def cmd_igp_pr(args, config):
    """Create a PR to update IGP gas/token prices in the upstream monorepo."""
    if not LATEST_SCAN.exists():
        print("No scan data found. Run 'scan' first.")
        sys.exit(1)

    with open(LATEST_SCAN) as f:
        scan_data = json.load(f)

    try:
        result = generate_igp_pr(
            config,
            scan_data,
            dry_run=args.dry_run,
            repo=args.repo,
        )

        if result.get("pr_url"):
            print(f"\nPR created: {result['pr_url']}")
        elif result.get("dry_run"):
            print(f"\n{result.get('message', 'Dry run complete.')}")
        else:
            print(f"\n{result.get('message', 'No changes to submit.')}")

    except Exception as e:
        print(f"IGP PR failed: {e}")
        sys.exit(1)


def _send_alerts(scan_data: dict, config: dict):
    """Send relevant Slack alerts."""
    webhook = config.get("alerts", {}).get("slack_webhook")

    igp_alert = format_igp_drift_alert(scan_data.get("igp_recommendations", {}))
    if igp_alert:
        send_slack_alert(igp_alert, webhook)
        print("  Sent IGP drift alert")

    safety_alert = format_safety_alert(scan_data.get("safety", {}).get("circuit_breaker", {}))
    if safety_alert:
        send_slack_alert(safety_alert, webhook)
        print("  Sent safety alert")

    comp_alert = format_competitive_alert(
        scan_data.get("competitive_summary", {}), config
    )
    if comp_alert:
        send_slack_alert(comp_alert, webhook)
        print("  Sent competitive position alert")

    stale_alert = format_stale_data_alert(scan_data.get("safety", {}).get("stale_sources", []))
    if stale_alert:
        send_slack_alert(stale_alert, webhook)
        print("  Sent stale data alert")


def cmd_serve(args, config):
    """Start the live web dashboard with background scanning."""
    from app import app, _scan_status, _after_scan_success
    from engine.infra_snapshots import InfraSnapshotError, list_snapshots
    from scheduler import start_scheduler
    from datetime import datetime, timezone

    # Register Jinja2 filters
    @app.template_filter('timestamp_fmt')
    def timestamp_fmt(ts):
        """Convert unix timestamp to readable UTC string."""
        try:
            dt = datetime.fromtimestamp(float(ts), tz=timezone.utc)
            return dt.strftime("%Y-%m-%d %H:%M UTC")
        except (ValueError, TypeError, OSError):
            return "Unknown"

    # Set last scan time from existing data if available
    if LATEST_SCAN.exists():
        import json
        with open(LATEST_SCAN) as f:
            data = json.load(f)
        _scan_status["last_scan_time"] = data.get("timestamp")
        if not list_snapshots():
            try:
                _after_scan_success(config, source_label="bootstrap_existing_scan")
            except InfraSnapshotError:
                pass

    # Start background scanner
    interval = config.get("scan_frequency", {}).get("gas_prices_minutes", 15)
    start_scheduler(
        config,
        cmd_scan,
        _scan_status,
        interval_minutes=interval,
        after_success=_after_scan_success,
    )
    print(f"  Background scanner: every {interval} min")

    port = args.port
    host = args.host
    print(f"=== Hyperlane Fee Autopilot — Live Dashboard ===")
    print(f"  http://{host}:{port}")
    print(f"  Press Ctrl+C to stop\n")

    if not args.no_open:
        import webbrowser
        import threading
        threading.Timer(1.0, lambda: webbrowser.open(f"http://{host}:{port}")).start()

    app.run(host=host, port=port, debug=False)


def main():
    parser = argparse.ArgumentParser(
        description="Hyperlane Fee Autopilot — Automated IGP & Warp Route Fee System",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # scan
    p_scan = subparsers.add_parser("scan", help="Collect all data")
    p_scan.add_argument("--no-competitors", action="store_true",
                        help="Skip competitor quotes (opt-out; market-unaware)")
    p_scan.add_argument("--monorepo", default=None,
                        help="Path to hyperlane-monorepo (default: configured runtime checkout)")

    # report
    p_report = subparsers.add_parser("report", help="Generate HTML dashboard")
    p_report.add_argument("--no-open", action="store_true",
                          help="Don't auto-open in browser")

    # recommend
    p_rec = subparsers.add_parser("recommend", help="Show fee recommendations")
    p_rec.add_argument("--alert", action="store_true",
                       help="Send Slack alerts for threshold breaches")

    # apply
    p_apply = subparsers.add_parser("apply", help="Generate updated fee JSON files")
    p_apply.add_argument("--force", action="store_true",
                         help="Override circuit breaker (dangerous)")

    # serve
    p_serve = subparsers.add_parser("serve", help="Start live web dashboard")
    p_serve.add_argument("--port", type=int, default=5001,
                         help="Port to listen on (default: 5001)")
    p_serve.add_argument("--host", default="127.0.0.1",
                         help="Host to bind to (default: 127.0.0.1)")
    p_serve.add_argument("--no-open", action="store_true",
                         help="Don't auto-open browser")

    # igp-review
    p_igp_review = subparsers.add_parser(
        "igp-review", help="Create/edit/approve an IGP submission proposal"
    )
    p_igp_review.add_argument(
        "--proposal",
        default=None,
        help="Existing proposal id or JSON path to edit",
    )
    p_igp_review.add_argument(
        "--managed-chain",
        action="append",
        default=None,
        help="Managed chain override (repeatable, proposal creation only)",
    )
    p_igp_review.add_argument(
        "--edit",
        action="append",
        default=[],
        help="Edit entry: chain:gas:token (repeatable, leave gas/token empty to skip)",
    )
    p_igp_review.add_argument(
        "--approve",
        action="store_true",
        help="Approve proposal after review edits",
    )
    p_igp_review.add_argument(
        "--confirmation-phrase",
        default=None,
        help="Review confirmation phrase (required with --approve)",
    )
    p_igp_review.add_argument(
        "--force",
        action="store_true",
        help="Allow max-delta/staleness overrides during approval",
    )

    # igp-validate
    p_igp_validate = subparsers.add_parser(
        "igp-validate", help="Validate an IGP submission proposal"
    )
    p_igp_validate.add_argument(
        "proposal",
        help="Proposal id or JSON path",
    )
    p_igp_validate.add_argument(
        "--force",
        action="store_true",
        help="Allow max-delta/staleness overrides in validation",
    )

    # igp-submit
    p_igp_submit = subparsers.add_parser(
        "igp-submit", help="Submit an approved IGP proposal"
    )
    p_igp_submit.add_argument("proposal", help="Proposal id or JSON path")
    p_igp_submit.add_argument(
        "--confirmation-phrase",
        required=True,
        help="Review confirmation phrase",
    )
    p_igp_submit.add_argument(
        "--dry-run",
        action="store_true",
        help="Run backend submission in dry-run mode",
    )
    p_igp_submit.add_argument(
        "--force",
        action="store_true",
        help="Override staleness/delta validation guardrails",
    )

    # igp-execute
    p_igp_execute = subparsers.add_parser(
        "igp-execute", help="Create + submit in one command"
    )
    p_igp_execute.add_argument(
        "--managed-chain",
        action="append",
        default=None,
        help="Managed chain override (repeatable)",
    )
    p_igp_execute.add_argument(
        "--edit",
        action="append",
        default=[],
        help="Edit entry: chain:gas:token (repeatable)",
    )
    p_igp_execute.add_argument(
        "--confirmation-phrase",
        required=True,
        help="Review confirmation phrase",
    )
    p_igp_execute.add_argument(
        "--dry-run",
        action="store_true",
        help="Run backend submission in dry-run mode",
    )
    p_igp_execute.add_argument(
        "--force",
        action="store_true",
        help="Override staleness/delta validation guardrails",
    )

    # igp-pr
    p_igp_pr = subparsers.add_parser(
        "igp-pr", help="Create a PR to update IGP gas/token prices in the monorepo"
    )
    p_igp_pr.add_argument(
        "--dry-run",
        action="store_true",
        help="Show diff without creating PR",
    )
    p_igp_pr.add_argument(
        "--repo",
        default="hyperlane-xyz/hyperlane-monorepo",
        help="Target repo (default: hyperlane-xyz/hyperlane-monorepo)",
    )

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    config = load_config()

    if args.command == "scan":
        cmd_scan(args, config)
    elif args.command == "report":
        cmd_report(args, config)
    elif args.command == "recommend":
        cmd_recommend(args, config)
    elif args.command == "apply":
        cmd_apply(args, config)
    elif args.command == "igp-review":
        cmd_igp_review(args, config)
    elif args.command == "igp-validate":
        cmd_igp_validate(args, config)
    elif args.command == "igp-submit":
        cmd_igp_submit(args, config)
    elif args.command == "igp-execute":
        cmd_igp_execute(args, config)
    elif args.command == "igp-pr":
        cmd_igp_pr(args, config)
    elif args.command == "serve":
        cmd_serve(args, config)


if __name__ == "__main__":
    main()

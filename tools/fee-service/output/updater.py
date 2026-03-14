"""Generate updated gasPrices.json / tokenPrices.json / calldata for fee changes."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from engine.monorepo_adapter import compute_floor_overrides


def generate_gas_prices_json(igp_recommendations: dict,
                             chains_config: dict) -> dict:
    """Generate an updated gasPrices.json from IGP recommendations.

    Format matches the existing monorepo structure:
    {
      "chainName": {"gasPrice": "123", "decimals": 9}
    }
    """
    output = {}
    seen_remotes = set()

    for route_key, rec in igp_recommendations.items():
        if rec.get("error") or rec.get("blocked"):
            continue

        remote = rec.get("remote_chain")
        if not remote or remote in seen_remotes:
            continue
        seen_remotes.add(remote)

        output[remote] = {
            "gasPrice": str(rec.get("gas_price", 0)),
            "decimals": rec.get("decimals", 9),
        }

    return output


def generate_token_prices_json(igp_recommendations: dict,
                               chains_config: dict) -> dict:
    """Generate an updated tokenPrices.json from IGP recommendations.

    Format:
    {
      "chainName": {"tokenPrice": "1234567890", "decimals": 10}
    }
    """
    output = {}
    seen_remotes = set()

    for route_key, rec in igp_recommendations.items():
        if rec.get("error") or rec.get("blocked"):
            continue

        remote = rec.get("remote_chain")
        if not remote or remote in seen_remotes:
            continue
        seen_remotes.add(remote)

        output[remote] = {
            "tokenPrice": str(rec.get("token_exchange_rate", 0)),
            "decimals": 10,
        }

    return output


def generate_warp_fee_config(warp_recommendations: dict) -> dict:
    """Generate warp fee configuration for RoutingFee + LinearFee setup.

    Output structure per route:
    {
        "token:src->dst": {
            "feeType": "LinearFee",
            "bps": 2,
            "maxFee": "1000000",  # in token smallest unit
            "halfAmount": "500000000"  # amount where fee = maxFee/2
        }
    }
    """
    output = {}
    for route_key, rec in warp_recommendations.items():
        if rec.get("error"):
            continue

        bps = rec.get("recommended_bps", 0)
        # LinearFee params: bps = (maxFee × 10000) / (halfAmount × 2)
        # Choose reasonable defaults for USDC/USDT (6 decimals)
        # maxFee = $10 worth = 10_000_000 (10 USDC in 6-decimal units)
        # halfAmount = maxFee × 10000 / (bps × 2)
        max_fee_raw = 10_000_000  # $10 in 6-decimal token
        if bps > 0:
            half_amount = int((max_fee_raw * 10000) / (bps * 2))
        else:
            half_amount = 0

        output[route_key] = {
            "fee_type": "LinearFee",
            "bps": bps,
            "max_fee": str(max_fee_raw),
            "half_amount": str(half_amount),
            "rationale": rec.get("rationale", ""),
        }

    return output


def build_igp_config_payload(
    igp_recommendations: dict,
    chains_config: dict,
    *,
    delivery_costs: dict | None = None,
    managed_chains: list[str] | None = None,
) -> dict:
    """Build the canonical IGP config payload served to Infra consumers."""
    managed = managed_chains or list(chains_config.keys())
    return {
        "gas_prices": generate_gas_prices_json(igp_recommendations, chains_config),
        "token_prices": generate_token_prices_json(igp_recommendations, chains_config),
        "floor_overrides": compute_floor_overrides(
            chains_config,
            delivery_costs or {},
            managed,
        ),
    }


def build_warp_config_payload(warp_recommendations: dict) -> dict:
    """Build the canonical warp config payload served to Infra consumers."""
    return {
        "routes": generate_warp_fee_config(warp_recommendations),
    }


def build_config_bundle_payload(
    igp_recommendations: dict,
    warp_recommendations: dict,
    chains_config: dict,
    *,
    delivery_costs: dict | None = None,
    managed_chains: list[str] | None = None,
) -> dict:
    """Build the combined Infra config bundle."""
    igp_payload = build_igp_config_payload(
        igp_recommendations,
        chains_config,
        delivery_costs=delivery_costs,
        managed_chains=managed_chains,
    )
    warp_payload = build_warp_config_payload(warp_recommendations)
    return {
        "igp": igp_payload,
        "warp": warp_payload,
    }


def write_update_files(igp_recommendations: dict, warp_recommendations: dict,
                       chains_config: dict, output_dir: str) -> dict:
    """Write all update files to the output directory.

    Returns: {files_written: [...], summary: str}
    """
    os.makedirs(output_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    files = []

    # gasPrices.json
    igp_payload = build_igp_config_payload(igp_recommendations, chains_config)
    gas_prices = igp_payload["gas_prices"]
    if gas_prices:
        path = os.path.join(output_dir, f"gasPrices_{ts}.json")
        with open(path, "w") as f:
            json.dump(gas_prices, f, indent=2)
        files.append(path)

        # Also write a "latest" symlink-style copy
        latest = os.path.join(output_dir, "gasPrices_latest.json")
        with open(latest, "w") as f:
            json.dump(gas_prices, f, indent=2)
        files.append(latest)

    # tokenPrices.json
    token_prices = igp_payload["token_prices"]
    if token_prices:
        path = os.path.join(output_dir, f"tokenPrices_{ts}.json")
        with open(path, "w") as f:
            json.dump(token_prices, f, indent=2)
        files.append(path)

        latest = os.path.join(output_dir, "tokenPrices_latest.json")
        with open(latest, "w") as f:
            json.dump(token_prices, f, indent=2)
        files.append(latest)

    # Warp fee config
    warp_payload = build_warp_config_payload(warp_recommendations)
    warp_config = warp_payload["routes"]
    if warp_config:
        path = os.path.join(output_dir, f"warpFees_{ts}.json")
        with open(path, "w") as f:
            json.dump(warp_config, f, indent=2)
        files.append(path)

        latest = os.path.join(output_dir, "warpFees_latest.json")
        with open(latest, "w") as f:
            json.dump(warp_config, f, indent=2)
        files.append(latest)

    # Compute diffs (current on-chain vs proposed)
    diffs = []
    for route_key, rec in warp_recommendations.items():
        if rec.get("error"):
            continue
        current = rec.get("current_fee_bps")
        proposed = rec.get("recommended_bps", 0)
        if current is not None:
            diffs.append({
                "route": route_key,
                "current_bps": current,
                "proposed_bps": proposed,
                "change_bps": round(proposed - current, 1),
            })

    # Summary
    n_igp_updates = sum(1 for r in igp_recommendations.values() if r.get("needs_update"))
    n_warp = sum(1 for r in warp_recommendations.values() if not r.get("error"))
    summary = (
        f"Generated {len(files)} files: "
        f"{n_igp_updates} IGP updates needed, "
        f"{n_warp} warp fee recommendations"
    )

    return {
        "files_written": files,
        "summary": summary,
        "diffs": diffs,
    }

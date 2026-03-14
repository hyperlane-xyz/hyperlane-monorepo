"""Generate fee recommendations: IGP + warp fee as distinct components.

User pays:  IGP quote (fixed $)  +  warp fee (proportional bps)  =  total cost
Competitor: all-in fee (varies by transfer size)

The IGP is a fixed dollar cost driven by gas — it doesn't scale with transfer size.
The warp fee is a single bps number applied to all transfers.

Warp fee recommendation logic:
  1. Cost floor = rebalancing bps (our minimum operating cost for the warp fee)
  2. Competitive target = median competitor warp-fee-equivalent across sizes
     (competitor all-in minus our IGP, converted to bps at each size)
  3. Warp fee = max(cost_floor, min_fee), capped by competitive target
  4. Clamp to [min_bps, max_bps]
  5. Show competitiveness breakdown at each transfer size
"""

from typing import Optional
from .competitive import compute_percentile_fee
from .cost_model import compute_igp_params

# Standard transfer sizes to evaluate competitiveness
EVAL_SIZES = [500, 1000, 5000, 10000, 25000, 50000, 100000, 300000]


def recommend_warp_fee(route_key: str, delivery_cost: dict,
                       competitor_quotes: dict, warp_config: dict,
                       rebalancing_cost: dict = None,
                       eval_sizes: list = None) -> dict:
    """Recommend a warp route fee for a specific route.

    The warp fee is a fixed bps number. We pick it based on:
    - Cost floor: rebalancing cost (our minimum to not lose money)
    - Competitive positioning: what bps would make our total cost
      (IGP fixed $ + warp bps) competitive across transfer sizes

    Args:
        delivery_cost: Delivery cost dict with raw_cost_usd and igp_quote_usd
        competitor_quotes: All competitor quotes at multiple sizes
        warp_config: Warp fee configuration
        rebalancing_cost: Optional rebalancing cost dict with 'bps' key
        eval_sizes: Transfer sizes to evaluate (default: EVAL_SIZES)
    """
    competitive_pctile = warp_config.get("competitive_percentile", 35)
    min_bps = warp_config.get("min_fee_bps", 1)
    max_bps = warp_config.get("max_fee_bps", 50)
    eval_sizes = eval_sizes or EVAL_SIZES

    igp_quote_usd = delivery_cost.get("igp_quote_usd", 0)

    # Rebalancing cost — the warp fee floor
    rebal_bps = 0
    rebal_source = None
    if rebalancing_cost:
        rebal_bps = rebalancing_cost.get("bps", 0)
        rebal_source = rebalancing_cost.get("source")

    cost_floor_bps = max(rebal_bps, min_bps)

    # Compute competitor warp-fee-equivalent at each transfer size:
    # "If we're charging IGP fixed $, what bps warp fee would match competitor p35?"
    # warp_equiv_bps = (competitor_all_in_usd - igp_quote_usd) / amount * 10000
    competitive_by_size = {}
    warp_equiv_bps_list = []

    for size in eval_sizes:
        comp_fee_usd = compute_percentile_fee(
            competitor_quotes, route_key, size, competitive_pctile
        )
        if comp_fee_usd is None:
            continue

        comp_all_in_bps = comp_fee_usd / size * 10000
        # What warp bps would make us match the competitor at this size?
        warp_equiv = (comp_fee_usd - igp_quote_usd) / size * 10000
        warp_equiv_bps_list.append(warp_equiv)

        competitive_by_size[size] = {
            "competitor_p35_usd": round(comp_fee_usd, 4),
            "competitor_p35_bps": round(comp_all_in_bps, 2),
            "warp_equiv_bps": round(warp_equiv, 2),
        }

    # Pick recommended bps: median of warp-equiv across sizes, floored to cost
    recommended_bps = cost_floor_bps
    competitive_target_bps = None
    rationale_parts = []

    if warp_equiv_bps_list:
        warp_equiv_bps_list.sort()
        mid = len(warp_equiv_bps_list) // 2
        competitive_target_bps = warp_equiv_bps_list[mid]

        rationale_parts.append(
            f"competitive target={competitive_target_bps:.2f} bps "
            f"(median warp-equiv across {len(warp_equiv_bps_list)} sizes)"
        )

        if competitive_target_bps > cost_floor_bps:
            # We have room — use the competitive target
            recommended_bps = competitive_target_bps
            rationale_parts.append("set to competitive target")
        else:
            # Competitors are cheaper even at warp-fee-only level
            recommended_bps = cost_floor_bps
            rationale_parts.append("at cost floor (competitors cheaper)")
    else:
        rationale_parts.append("no competitive data; using cost floor")

    if rebal_bps > 0:
        rationale_parts.append(f"rebalancing={rebal_bps:.2f} bps ({rebal_source})")

    # Clamp
    clamped = False
    if recommended_bps < min_bps:
        recommended_bps = min_bps
        clamped = True
    if recommended_bps > max_bps:
        recommended_bps = max_bps
        clamped = True

    rationale_parts.append(f"warp fee={recommended_bps:.1f} bps")

    # Now compute the full competitiveness picture at each size
    for size in eval_sizes:
        our_total_usd = igp_quote_usd + (recommended_bps / 10000) * size
        our_total_bps = our_total_usd / size * 10000
        entry = competitive_by_size.get(size, {})
        entry["our_total_usd"] = round(our_total_usd, 4)
        entry["our_total_bps"] = round(our_total_bps, 2)
        entry["igp_usd"] = round(igp_quote_usd, 4)
        entry["warp_usd"] = round((recommended_bps / 10000) * size, 4)

        comp_usd = entry.get("competitor_p35_usd")
        if comp_usd is not None:
            diff = our_total_usd - comp_usd
            entry["vs_competitor_usd"] = round(diff, 4)
            if diff < 0:
                entry["position"] = "cheaper"
            elif our_total_bps <= entry.get("competitor_p35_bps", 0) * 1.25:
                entry["position"] = "competitive"
            else:
                entry["position"] = "expensive"

        competitive_by_size[size] = entry

    return {
        "recommended_bps": round(recommended_bps, 1),
        "igp_quote_usd": round(igp_quote_usd, 4),
        "rebalancing_bps": round(rebal_bps, 2),
        "rebalancing_source": rebal_source,
        "cost_floor_bps": round(cost_floor_bps, 2),
        "competitive_target_bps": round(competitive_target_bps, 2) if competitive_target_bps is not None else None,
        "clamped": clamped,
        "rationale": "; ".join(rationale_parts),
        "competitiveness_by_size": competitive_by_size,
    }


def recommend_igp_update(local_chain: str, remote_chain: str,
                         gas_data: dict, token_prices: dict,
                         chains_config: dict, igp_config: dict,
                         current_state: dict) -> dict:
    """Recommend IGP parameter updates."""
    recommended = compute_igp_params(
        local_chain, remote_chain, gas_data, token_prices,
        chains_config, igp_config,
    )

    if "error" in recommended:
        return recommended

    diff_threshold = igp_config.get("diff_threshold_pct", 5) / 100

    current_gas = current_state.get("igp", {}).get("gas_prices", {}).get(remote_chain, {})
    current_token = current_state.get("igp", {}).get("token_prices", {}).get(remote_chain, {})

    gas_price_diff = None
    token_price_diff = None
    needs_update = False

    if current_gas.get("gas_price"):
        current_gp = current_gas["gas_price"]
        new_gp = recommended["gas_price"]
        if current_gp > 0:
            gas_price_diff = abs(new_gp - current_gp) / current_gp
            if gas_price_diff > diff_threshold:
                needs_update = True

    if current_token.get("token_price"):
        current_tp = int(current_token["token_price"])
        new_tp = recommended["token_exchange_rate"]
        if current_tp > 0:
            token_price_diff = abs(new_tp - current_tp) / current_tp
            if token_price_diff > diff_threshold:
                needs_update = True

    return {
        **recommended,
        "current_gas_price": current_gas.get("gas_price"),
        "current_token_price": current_token.get("token_price"),
        "gas_price_diff_pct": round(gas_price_diff * 100, 1) if gas_price_diff else None,
        "token_price_diff_pct": round(token_price_diff * 100, 1) if token_price_diff else None,
        "needs_update": needs_update,
        "diff_threshold_pct": igp_config.get("diff_threshold_pct", 5),
    }


def recommend_all_warp_fees(routes: list, delivery_costs: dict,
                            competitor_quotes: dict, warp_config: dict,
                            chains_config: dict,
                            live_warp_fees: dict = None,
                            rebalancing_provider=None) -> dict:
    """Generate warp fee recommendations for all routes.

    Args:
        live_warp_fees: On-chain fee data from HyperlaneStateCollector.
            Keys are route_keys like "USDC:arbitrum->base", values have
            "fees_by_amount" with per-size fee data.
        rebalancing_provider: Optional RebalancingCostProvider instance.
    """
    live_warp_fees = live_warp_fees or {}
    recommendations = {}
    for route in routes:
        token = route["token"]
        chains = route["chains"]
        for i, src in enumerate(chains):
            for dst in chains:
                if src == dst:
                    continue
                route_key = f"{token}:{src}->{dst}"
                dst_data = delivery_costs.get(dst, {})
                if dst_data.get("raw_cost_usd") is None:
                    recommendations[route_key] = {"error": f"No delivery cost for {dst}"}
                    continue

                # Get rebalancing cost for this route-pair
                rebal_cost = None
                if rebalancing_provider:
                    rebal_cost = rebalancing_provider.get_cost(src, dst)

                rec = recommend_warp_fee(
                    route_key, dst_data, competitor_quotes, warp_config,
                    rebalancing_cost=rebal_cost,
                )

                # Attach live on-chain fee data
                live = live_warp_fees.get(route_key, {})
                if live:
                    live_by_amount = live.get("fees_by_amount", {})
                    # Get fee at the reference transfer size ($1000)
                    ref = live_by_amount.get(1000) or live_by_amount.get("1000", {})
                    rec["current_fee_bps"] = ref.get("fee_bps", 0)
                    rec["current_fee_usd"] = ref.get("fee_usd", 0)
                    rec["fee_recipient"] = live.get("fee_recipient")
                    rec["live_fees_by_amount"] = live_by_amount

                recommendations[route_key] = rec
    return recommendations


def recommend_all_igp_updates(chains_config: dict, gas_data: dict,
                              token_prices: dict, igp_config: dict,
                              current_state: dict) -> dict:
    """Generate IGP update recommendations for all chain pairs."""
    recommendations = {}
    chain_names = list(chains_config.keys())
    for local in chain_names:
        for remote in chain_names:
            if local == remote:
                continue
            key = f"{local}->{remote}"
            recommendations[key] = recommend_igp_update(
                local, remote, gas_data, token_prices,
                chains_config, igp_config, current_state,
            )
    return recommendations

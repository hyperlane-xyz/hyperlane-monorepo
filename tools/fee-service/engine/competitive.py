"""Analyze Hyperlane's competitive position vs bridge competitors."""

import statistics
from typing import Optional


def analyze_route(route_key: str, competitor_quotes: dict,
                  igp_quote_usd: float, live_fee_data: dict = None) -> dict:
    """Analyze competitive position for a single route.

    Computes Hyperlane's all-in fee to user at each transfer size:
        fee_to_user = IGP quote (fixed) + warp fee (proportional, on-chain)
    Then compares against competitor all-in fees.

    Args:
        igp_quote_usd: IGP gas delivery quote (fixed per-message cost to user).
        live_fee_data: On-chain warp fee data with fees_by_amount per size.
    """
    route_data = competitor_quotes.get(route_key, {})
    if not route_data:
        return {"error": "No competitor quotes", "route": route_key}

    live_fee_data = live_fee_data or {}
    fees_by_amount = live_fee_data.get("fees_by_amount", {})

    # Discover all transfer sizes present in the data
    all_amounts = set()
    for competitor, amounts in route_data.items():
        if isinstance(amounts, dict):
            for k in amounts:
                try:
                    all_amounts.add(int(k))
                except (ValueError, TypeError):
                    pass

    by_amount = {}
    for amount_usd in sorted(all_amounts):
        quotes = []
        for competitor, amounts in route_data.items():
            if isinstance(amounts, dict) and (amount_usd in amounts or str(amount_usd) in amounts):
                q = amounts.get(amount_usd) or amounts.get(str(amount_usd))
                if q:
                    quotes.append({
                        "name": competitor,
                        "fee_usd": q.get("fee_usd", 0),
                        "fee_bps": q.get("fee_bps", 0),
                    })

        if not quotes:
            continue

        # Sort by fee
        quotes.sort(key=lambda x: x["fee_usd"])
        fees = [q["fee_usd"] for q in quotes]
        bps_list = [q["fee_bps"] for q in quotes]

        # Hyperlane all-in FEE TO USER at this transfer size:
        #   = IGP quote (fixed per-message) + warp fee (proportional, from on-chain)
        warp_fee_usd = 0
        ref = fees_by_amount.get(amount_usd) or fees_by_amount.get(str(amount_usd), {})
        if ref:
            warp_fee_usd = ref.get("fee_usd", 0)
        hl_fee_to_user = igp_quote_usd + warp_fee_usd

        n_cheaper = sum(1 for f in fees if f < hl_fee_to_user)
        percentile = (n_cheaper / len(fees)) * 100 if fees else 50

        if percentile < 25:
            position = "cheapest"
        elif percentile < 60:
            position = "competitive"
        else:
            position = "expensive"

        by_amount[amount_usd] = {
            "quotes": quotes,
            "median_fee_usd": statistics.median(fees) if fees else 0,
            "median_fee_bps": statistics.median(bps_list) if bps_list else 0,
            "cheapest": quotes[0] if quotes else None,
            "most_expensive": quotes[-1] if quotes else None,
            "percentile": percentile,
            "hyperlane_fee_to_user_usd": hl_fee_to_user,
            "hyperlane_igp_usd": igp_quote_usd,
            "hyperlane_warp_fee_usd": warp_fee_usd,
            "position": position,
            "n_competitors": len(quotes),
        }

    return by_amount


def compute_percentile_fee(competitor_quotes: dict, route_key: str,
                           amount_usd: int, percentile: float) -> Optional[float]:
    """Get the competitor fee at a given percentile for a route and amount.

    percentile=35 means "cheaper than 65% of competitors".
    """
    route_data = competitor_quotes.get(route_key, {})
    fees = []
    for competitor, amounts in route_data.items():
        if isinstance(amounts, dict):
            q = amounts.get(amount_usd) or amounts.get(str(amount_usd))
            if q:
                fees.append(q.get("fee_usd", 0))

    if not fees:
        return None

    fees.sort()
    idx = int(len(fees) * percentile / 100)
    idx = min(idx, len(fees) - 1)
    return fees[idx]


def competitive_summary(competitor_quotes: dict, delivery_costs: dict,
                        chains_config: dict,
                        live_warp_fees: dict = None) -> dict:
    """Generate a summary of competitive position across all routes.

    Args:
        live_warp_fees: On-chain fee data keyed by route_key.
            Used to compute real all-in Hyperlane cost (IGP + warp fee).
    """
    live_warp_fees = live_warp_fees or {}
    summary = {
        "routes": {},
        "overall_position": None,
        "n_routes_analyzed": 0,
        "n_routes_cheaper": 0,
        "n_routes_competitive": 0,
        "n_routes_expensive": 0,
    }

    for route_key, route_data in competitor_quotes.items():
        if not route_data:
            continue

        # Parse route key: "TOKEN:src->dst"
        parts = route_key.split(":")
        if len(parts) != 2:
            continue
        token = parts[0]
        chains = parts[1].split("->")
        if len(chains) != 2:
            continue
        dst = chains[1]

        # Get delivery cost to destination
        dst_cost = delivery_costs.get(dst, {})
        igp_quote = dst_cost.get("igp_quote_usd") or dst_cost.get("raw_cost_usd", 0) or 0

        # Pass live on-chain warp fee data so analyze_route can compute
        # the correct all-in fee at each transfer size
        live_fee = live_warp_fees.get(route_key, {})

        analysis = analyze_route(route_key, competitor_quotes, igp_quote, live_fee)
        if "error" in analysis:
            continue

        summary["routes"][route_key] = analysis
        summary["n_routes_analyzed"] += 1

        # Check position at $1000 (most common bridge size)
        if 1000 in analysis:
            pos = analysis[1000].get("position", "unknown")
            if pos == "cheapest":
                summary["n_routes_cheaper"] += 1
            elif pos == "competitive":
                summary["n_routes_competitive"] += 1
            elif pos == "expensive":
                summary["n_routes_expensive"] += 1

    n = summary["n_routes_analyzed"]
    if n > 0:
        if summary["n_routes_cheaper"] > n * 0.5:
            summary["overall_position"] = "cheapest"
        elif summary["n_routes_expensive"] > n * 0.5:
            summary["overall_position"] = "expensive"
        else:
            summary["overall_position"] = "competitive"

    return summary

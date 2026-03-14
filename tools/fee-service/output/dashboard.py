"""Generate self-contained HTML dashboard report."""

import math
import time
from datetime import datetime, timezone


def fmt_usd(val, compact=False):
    if val is None:
        return "N/A"
    if compact:
        if abs(val) >= 1_000_000:
            return f"${val/1_000_000:.1f}M"
        if abs(val) >= 1_000:
            return f"${val/1_000:.1f}K"
        return f"${val:,.2f}"
    return f"${val:,.4f}" if abs(val) < 1 else f"${val:,.2f}"


def fmt_bps(val):
    if val is None:
        return "N/A"
    return f"{val:.1f} bps"


def fmt_gwei(val):
    if val is None:
        return "N/A"
    return f"{val:.2f} gwei"


def fmt_pct(val):
    if val is None:
        return "N/A"
    sign = "+" if val > 0 else ""
    return f"{sign}{val:.1f}%"


def status_badge(status, text=None):
    colors = {
        "ok": "#22c55e",
        "warning": "#eab308",
        "stale": "#f97316",
        "error": "#ef4444",
        "cheapest": "#22c55e",
        "competitive": "#3b82f6",
        "expensive": "#ef4444",
        "needs_update": "#eab308",
        "current": "#22c55e",
    }
    bg = colors.get(status, "#6b7280")
    label = text or status.upper()
    return f'<span class="badge" style="background:{bg};">{label}</span>'


def generate_dashboard(scan_data: dict) -> str:
    """Generate the full HTML dashboard from scan data."""
    now = datetime.now(timezone.utc)
    ts_str = now.strftime("%Y-%m-%d %H:%M UTC")

    gas_data = scan_data.get("gas_prices", {})
    token_prices = scan_data.get("token_prices", {})
    delivery_costs = scan_data.get("delivery_costs", {})
    hyperlane_state = scan_data.get("hyperlane_state", {})
    competitor_quotes = scan_data.get("competitor_quotes", {})
    competitive = scan_data.get("competitive_summary", {})
    igp_recommendations = scan_data.get("igp_recommendations", {})
    warp_recommendations = scan_data.get("warp_recommendations", {})
    safety = scan_data.get("safety", {})

    sections = []
    sections.append(_section_header(ts_str, scan_data))
    sections.append(_section_summary_cards(gas_data, token_prices, delivery_costs,
                                           competitive, safety))
    sections.append(_section_gas_prices(gas_data, delivery_costs))
    sections.append(_section_token_prices(token_prices))
    sections.append(_section_delivery_costs(delivery_costs))
    sections.append(_section_igp_status(hyperlane_state, igp_recommendations))
    sections.append(_section_competitor_comparison(competitor_quotes, competitive))
    sections.append(_section_warp_recommendations(warp_recommendations))
    sections.append(_section_igp_recommendations(igp_recommendations))
    sections.append(_section_safety(safety))

    body = "\n".join(sections)
    return _wrap_html(body, ts_str)


def _section_header(ts_str: str, scan_data: dict) -> str:
    circuit = scan_data.get("safety", {}).get("circuit_breaker", {})
    status = "HALTED" if circuit.get("halt") else "ACTIVE"
    status_color = "#ef4444" if circuit.get("halt") else "#22c55e"
    return f"""
    <header>
        <h1>Hyperlane Fee Autopilot</h1>
        <p class="subtitle">Last scan: {ts_str}
            <span class="badge" style="background:{status_color};margin-left:8px;">{status}</span>
        </p>
    </header>"""


def _section_summary_cards(gas_data, token_prices, delivery_costs,
                           competitive, safety) -> str:
    eth_price = token_prices.get("ethereum", {}).get("usd", 0)
    sol_price = token_prices.get("solana", {}).get("usd", 0)
    eth_gas = gas_data.get("ethereum", {}).get("gas_price_gwei", 0)
    arb_gas = gas_data.get("arbitrum", {}).get("gas_price_gwei", 0)

    n_chains = len(gas_data)
    n_routes = competitive.get("n_routes_analyzed", 0)
    position = competitive.get("overall_position", "unknown")

    # Average delivery cost
    costs = [v.get("igp_quote_usd", 0) for v in delivery_costs.values()
             if isinstance(v, dict) and v.get("igp_quote_usd")]
    avg_cost = sum(costs) / len(costs) if costs else 0

    return f"""
    <section class="summary-grid">
        <div class="card">
            <div class="card-label">ETH Price</div>
            <div class="card-value">{fmt_usd(eth_price)}</div>
            <div class="card-sub">Gas: {fmt_gwei(eth_gas)}</div>
        </div>
        <div class="card">
            <div class="card-label">SOL Price</div>
            <div class="card-value">{fmt_usd(sol_price)}</div>
        </div>
        <div class="card">
            <div class="card-label">Chains Monitored</div>
            <div class="card-value">{n_chains}</div>
            <div class="card-sub">Arb gas: {fmt_gwei(arb_gas)}</div>
        </div>
        <div class="card">
            <div class="card-label">Avg Delivery Cost</div>
            <div class="card-value">{fmt_usd(avg_cost)}</div>
        </div>
        <div class="card">
            <div class="card-label">Competitive Position</div>
            <div class="card-value">{status_badge(position, position.title()) if position and position != "unknown" else '<span style="color:#888">No data</span>'}</div>
            <div class="card-sub">{f'{n_routes} routes analyzed' if n_routes else 'Run scan (competitors included by default)'}</div>
        </div>
    </section>"""


def _section_gas_prices(gas_data: dict, delivery_costs: dict) -> str:
    rows = []
    for chain, data in sorted(gas_data.items()):
        if not isinstance(data, dict):
            continue
        cost_data = delivery_costs.get(chain, {}) if isinstance(delivery_costs, dict) else {}
        raw_cost_usd = cost_data.get("raw_cost_usd") if isinstance(cost_data, dict) else None
        usd_str = fmt_usd(raw_cost_usd) if raw_cost_usd is not None else "N/A"
        chain_type = data.get("type", "evm")
        if chain_type == "sealevel":
            price_str = f"{data.get('base_fee_lamports', 0)} lamports base"
            priority = data.get("priority_fee_microlamports", 0)
            detail = f"Priority: {priority} μlamports/CU"
        else:
            price_str = fmt_gwei(data.get("gas_price_gwei", 0))
            l1 = data.get("l1_fee_scalar")
            detail = f"L1 base: {l1:.2f} gwei" if l1 else ""

        rows.append(f"""
            <tr>
                <td>{chain}</td>
                <td>{chain_type.upper()}</td>
                <td class="num">{price_str}</td>
                <td class="num">{usd_str}</td>
                <td>{detail}</td>
            </tr>""")

    return f"""
    <section class="section">
        <h2>Live Gas Prices</h2>
        <table class="data-table">
            <thead><tr>
                <th>Chain</th><th>Type</th><th>Gas Price</th><th>Raw Gas Cost (USD/msg)</th><th>Details</th>
            </tr></thead>
            <tbody>{"".join(rows)}</tbody>
        </table>
    </section>"""


def _section_token_prices(token_prices: dict) -> str:
    rows = []
    for token, data in sorted(token_prices.items()):
        if not isinstance(data, dict):
            continue
        rows.append(f"""
            <tr>
                <td>{token.upper()}</td>
                <td class="num">{fmt_usd(data.get('usd', 0))}</td>
                <td>{data.get('source', '')}</td>
            </tr>""")

    return f"""
    <section class="section">
        <h2>Token Prices</h2>
        <table class="data-table">
            <thead><tr><th>Token</th><th>USD Price</th><th>Source</th></tr></thead>
            <tbody>{"".join(rows)}</tbody>
        </table>
    </section>"""


def _section_delivery_costs(delivery_costs: dict) -> str:
    rows = []
    for chain, data in sorted(delivery_costs.items()):
        if not isinstance(data, dict):
            continue
        raw = data.get("raw_cost_usd")
        igp = data.get("igp_quote_usd")
        margin = data.get("igp_margin_pct", 0)
        min_applied = data.get("min_usd_applied", False)
        min_val = data.get("min_usd_value", 0)
        overhead = data.get("gas_overhead", 0)

        note = f"{overhead:,} gas"
        if min_applied:
            note += f" | IGP floored to ${min_val}"
        if data.get("error"):
            note = data["error"]

        rows.append(f"""
            <tr>
                <td>{chain}</td>
                <td class="num">{fmt_usd(raw) if raw else 'N/A'}</td>
                <td class="num">{fmt_usd(igp) if igp else 'N/A'}</td>
                <td class="num">{margin}%</td>
                <td>{'Yes' if min_applied else ''}</td>
                <td>{note}</td>
            </tr>""")

    return f"""
    <section class="section">
        <h2>Delivery Costs (per message)</h2>
        <p><strong>Raw cost</strong> = actual gas. <strong>IGP quote</strong> = what user pays for gas delivery (raw + {margin}% margin, floored).</p>
        <table class="data-table">
            <thead><tr>
                <th>Destination</th><th>Raw Gas Cost</th><th>IGP Quote</th>
                <th>Margin</th><th>Floor?</th><th>Notes</th>
            </tr></thead>
            <tbody>{"".join(rows)}</tbody>
        </table>
    </section>"""


def _section_igp_status(hyperlane_state: dict, igp_recs: dict) -> str:
    igp = hyperlane_state.get("igp", {})
    gas_prices = igp.get("gas_prices", {})
    token_prices = igp.get("token_prices", {})

    rows = []
    seen = set()
    for route_key, rec in sorted(igp_recs.items()):
        remote = rec.get("remote_chain", "")
        if remote in seen:
            continue
        seen.add(remote)

        current_gp = gas_prices.get(remote, {}).get("gas_price", "?")
        current_tp = token_prices.get(remote, {}).get("token_price", "?")
        rec_gp = rec.get("gas_price", "?")
        rec_tp = rec.get("token_exchange_rate", "?")
        needs = rec.get("needs_update", False)
        gas_diff = rec.get("gas_price_diff_pct")
        token_diff = rec.get("token_price_diff_pct")

        status = "needs_update" if needs else "current"

        rows.append(f"""
            <tr>
                <td>{remote}</td>
                <td class="num">{current_gp}</td>
                <td class="num">{rec_gp}</td>
                <td class="num">{fmt_pct(gas_diff) if gas_diff else '—'}</td>
                <td class="num">{current_tp}</td>
                <td class="num">{rec_tp}</td>
                <td class="num">{fmt_pct(token_diff) if token_diff else '—'}</td>
                <td>{status_badge(status)}</td>
            </tr>""")

    return f"""
    <section class="section">
        <h2>IGP Gas Oracle Status</h2>
        <p>Current vs recommended IGP parameters. Updates flagged when drift &gt;5%.</p>
        <table class="data-table sortable">
            <thead><tr>
                <th>Chain</th>
                <th data-sort="num">Current Gas</th>
                <th data-sort="num">Recommended</th>
                <th data-sort="num">Gas Drift</th>
                <th data-sort="num">Current Token</th>
                <th data-sort="num">Recommended</th>
                <th data-sort="num">Token Drift</th>
                <th>Status</th>
            </tr></thead>
            <tbody>{"".join(rows)}</tbody>
        </table>
    </section>"""


def _section_competitor_comparison(competitor_quotes: dict, competitive: dict) -> str:
    routes = competitive.get("routes", {})
    if not routes:
        return """
        <section class="section">
            <h2>Competitor Comparison</h2>
            <p>No competitor quotes collected yet. Run <code>python main.py scan</code>.</p>
        </section>"""

    # Discover all transfer sizes across all routes
    all_amounts = set()
    for route_key, analysis in routes.items():
        if isinstance(analysis, dict):
            for k in analysis:
                try:
                    all_amounts.add(int(k))
                except (ValueError, TypeError):
                    pass
    amounts_sorted = sorted(all_amounts)

    def _fmt_amount(a):
        if a >= 1000:
            return f"${a // 1000}K"
        return f"${a}"

    # Summary table: one row per route, columns = transfer sizes, cell = cheapest competitor bps
    summary_rows = []
    for route_key in sorted(routes.keys()):
        analysis = routes[route_key]
        if not isinstance(analysis, dict) or "error" in analysis:
            continue

        cells = []
        for amt in amounts_sorted:
            tier = analysis.get(amt) or analysis.get(str(amt))
            if not tier:
                cells.append('<td class="num">—</td>')
                continue
            cheapest = tier.get("cheapest", {})
            name = cheapest.get("name", "")
            fee_bps = cheapest.get("fee_bps", 0)
            position = tier.get("position", "unknown")
            colors = {"cheapest": "#22c55e", "competitive": "#3b82f6", "expensive": "#ef4444"}
            color = colors.get(position, "#94a3b8")
            cells.append(
                f'<td class="num" style="color:{color};" '
                f'title="{name}: {fmt_usd(cheapest.get("fee_usd", 0))}">'
                f'{fee_bps:.1f}</td>'
            )
        summary_rows.append(f'<tr><td>{route_key}</td>{"".join(cells)}</tr>')

    amt_headers = "".join(
        f'<th data-sort="num">{_fmt_amount(a)}</th>' for a in amounts_sorted
    )

    # Detailed per-route fee curves: show each competitor at each size
    detail_blocks = []
    # Group routes by token
    token_routes = {}
    for route_key in sorted(routes.keys()):
        token = route_key.split(":")[0]
        token_routes.setdefault(token, []).append(route_key)

    for token, route_keys in sorted(token_routes.items()):
        route_tables = []
        for route_key in route_keys:
            analysis = routes[route_key]
            if not isinstance(analysis, dict) or "error" in analysis:
                continue

            # Collect all competitors across all sizes
            competitors = set()
            for amt in amounts_sorted:
                tier = analysis.get(amt) or analysis.get(str(amt))
                if tier:
                    for q in tier.get("quotes", []):
                        competitors.add(q["name"])

            if not competitors:
                continue

            # Build rows: one per competitor + Hyperlane delivery cost
            comp_rows = []
            for comp in sorted(competitors):
                cells = []
                for amt in amounts_sorted:
                    tier = analysis.get(amt) or analysis.get(str(amt))
                    if not tier:
                        cells.append('<td class="num">—</td>')
                        continue
                    match = [q for q in tier.get("quotes", []) if q["name"] == comp]
                    if match:
                        bps = match[0]["fee_bps"]
                        usd = match[0]["fee_usd"]
                        cells.append(
                            f'<td class="num" title="{fmt_usd(usd)}">{bps:.1f}</td>'
                        )
                    else:
                        cells.append('<td class="num">—</td>')
                comp_rows.append(f'<tr><td>{comp}</td>{"".join(cells)}</tr>')

            # Hyperlane row (all-in fee to user = IGP + warp fee at each size)
            hl_cells = []
            for amt in amounts_sorted:
                tier = analysis.get(amt) or analysis.get(str(amt))
                hl_fee = tier.get("hyperlane_fee_to_user_usd", 0) if tier else 0
                if hl_fee and amt > 0:
                    hl_bps = hl_fee / amt * 10000
                    igp_usd = tier.get("hyperlane_igp_usd", 0) if tier else 0
                    warp_usd = tier.get("hyperlane_warp_fee_usd", 0) if tier else 0
                    hl_cells.append(
                        f'<td class="num" style="color:#a855f7;font-weight:700;" '
                        f'title="IGP: {fmt_usd(igp_usd)} + Warp: {fmt_usd(warp_usd)} = {fmt_usd(hl_fee)}">{hl_bps:.1f}</td>'
                    )
                else:
                    hl_cells.append('<td class="num">—</td>')
            comp_rows.append(
                f'<tr style="border-top:2px solid var(--border);">'
                f'<td style="color:#a855f7;font-weight:700;">Hyperlane (fee to user)</td>'
                f'{"".join(hl_cells)}</tr>'
            )

            route_tables.append(f"""
                <div class="fee-curve-block">
                    <h4>{route_key}</h4>
                    <table class="data-table fee-curve-table">
                        <thead><tr><th>Bridge</th>{amt_headers}</tr></thead>
                        <tbody>{"".join(comp_rows)}</tbody>
                    </table>
                </div>""")

        if route_tables:
            detail_blocks.append(f"""
                <div class="token-group">
                    <h3>{token} Routes</h3>
                    <div class="fee-curve-grid">{"".join(route_tables)}</div>
                </div>""")

    return f"""
    <section class="section">
        <h2>Competitor Fee Overview</h2>
        <p>Cheapest competitor fee in bps at each transfer size. Hover for USD amount.
           Colors: <span style="color:#22c55e;">cheapest</span>,
           <span style="color:#3b82f6;">competitive</span>,
           <span style="color:#ef4444;">expensive</span> vs Hyperlane all-in fee to user (IGP + warp fee).</p>
        <table class="data-table sortable">
            <thead><tr><th>Route</th>{amt_headers}</tr></thead>
            <tbody>{"".join(summary_rows)}</tbody>
        </table>
    </section>

    <section class="section">
        <h2>Fee Curves by Route (bps)</h2>
        <p>All competitor fees at each transfer size.
           <span style="color:#a855f7;font-weight:700;">Purple</span> = Hyperlane all-in fee to user (IGP + warp fee). Hover for breakdown.</p>
        {"".join(detail_blocks)}
    </section>"""


def _section_warp_recommendations(warp_recs: dict) -> str:
    if not warp_recs:
        return ""

    rows = []
    for route_key, rec in sorted(warp_recs.items()):
        if rec.get("error"):
            continue
        igp_usd = rec.get("igp_quote_usd", 0)
        current_bps = rec.get("current_fee_bps")
        rec_bps = rec.get("recommended_bps", 0)
        cost_floor = rec.get("cost_floor_bps", 0)
        comp_target = rec.get("competitive_target_bps")
        rebal_bps = rec.get("rebalancing_bps", 0)
        rationale = rec.get("rationale", "")

        # Current fee display
        if current_bps is not None:
            current_str = fmt_bps(current_bps)
            change_color = "#22c55e" if current_bps == rec_bps else "#eab308"
        else:
            current_str = '<span style="color:#666;">N/A</span>'
            change_color = "#94a3b8"

        rows.append(f"""
            <tr>
                <td>{route_key}</td>
                <td class="num">{fmt_usd(igp_usd)}</td>
                <td class="num" style="font-weight:700;color:#22d3ee;">{current_str}</td>
                <td class="num" style="font-weight:700;color:{change_color};">{fmt_bps(rec_bps)}</td>
                <td class="num">{fmt_bps(comp_target) if comp_target is not None else '—'}</td>
                <td class="num">{fmt_bps(cost_floor)}</td>
                <td class="num">{fmt_bps(rebal_bps) if rebal_bps else '—'}</td>
                <td class="rationale">{rationale}</td>
            </tr>""")

    return f"""
    <section class="section">
        <h2>Warp Fee Analysis — FPWR USDC</h2>
        <p>User pays <strong>IGP (fixed $) + Warp Fee (bps)</strong>. Competitors charge one all-in fee.<br>
           <span style="color:#22d3ee;">Cyan</span> = current on-chain warp fee.
           Competitive target = median warp-fee-equivalent across transfer sizes at p35.</p>
        <table class="data-table sortable">
            <thead><tr>
                <th>Route</th>
                <th data-sort="num">IGP ($)</th>
                <th data-sort="num">Current (on-chain)</th>
                <th data-sort="num">Recommended</th>
                <th data-sort="num">Comp. Target</th>
                <th data-sort="num">Cost Floor</th>
                <th data-sort="num">Rebalancing</th>
                <th>Rationale</th>
            </tr></thead>
            <tbody>{"".join(rows)}</tbody>
        </table>
    </section>"""


def _section_igp_recommendations(igp_recs: dict) -> str:
    needs_update = {k: v for k, v in igp_recs.items() if v.get("needs_update")}
    if not needs_update:
        return """
        <section class="section">
            <h2>IGP Recommendations</h2>
            <p style="color:#22c55e;">All IGP parameters are within 5% of live values. No updates needed.</p>
        </section>"""

    rows = []
    for route_key, rec in sorted(needs_update.items()):
        gas_diff = rec.get("gas_price_diff_pct", 0) or 0
        token_diff = rec.get("token_price_diff_pct", 0) or 0
        max_diff = max(gas_diff, token_diff)

        rows.append(f"""
            <tr>
                <td>{route_key}</td>
                <td class="num">{rec.get('current_gas_price', '?')} → {rec.get('gas_price', '?')}</td>
                <td class="num">{fmt_pct(gas_diff)}</td>
                <td class="num">{rec.get('current_token_price', '?')} → {rec.get('token_exchange_rate', '?')}</td>
                <td class="num">{fmt_pct(token_diff)}</td>
                <td>{status_badge('needs_update', f'{max_diff:.0f}% drift')}</td>
            </tr>""")

    return f"""
    <section class="section">
        <h2>IGP Recommendations ({len(needs_update)} updates needed)</h2>
        <table class="data-table sortable">
            <thead><tr>
                <th>Route</th>
                <th>Gas Price Change</th>
                <th data-sort="num">Gas Drift</th>
                <th>Token Price Change</th>
                <th data-sort="num">Token Drift</th>
                <th>Status</th>
            </tr></thead>
            <tbody>{"".join(rows)}</tbody>
        </table>
    </section>"""


def _section_safety(safety_data: dict) -> str:
    cb = safety_data.get("circuit_breaker", {})
    stale = safety_data.get("stale_sources", [])

    cb_status = "error" if cb.get("halt") else "ok"
    cb_label = "HALTED" if cb.get("halt") else "OK"
    issues = cb.get("issues", [])
    issue_html = "".join(f"<li>{i}</li>" for i in issues) if issues else "<li>None</li>"
    stale_html = "".join(f"<li>{s}</li>" for s in stale) if stale else "<li>All fresh</li>"

    return f"""
    <section class="section">
        <h2>Safety Status</h2>
        <div class="safety-grid">
            <div class="card">
                <div class="card-label">Circuit Breaker</div>
                <div class="card-value">{status_badge(cb_status, cb_label)}</div>
                <ul class="safety-list">{issue_html}</ul>
            </div>
            <div class="card">
                <div class="card-label">Data Freshness</div>
                <ul class="safety-list">{stale_html}</ul>
            </div>
        </div>
    </section>"""


def _wrap_html(body: str, ts_str: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hyperlane Fee Autopilot — {ts_str}</title>
<style>
:root {{
    --bg-primary: #0f172a;
    --bg-secondary: #1e293b;
    --bg-card: #1e293b;
    --text: #e2e8f0;
    --text-muted: #94a3b8;
    --accent-blue: #3b82f6;
    --accent-cyan: #22d3ee;
    --accent-green: #22c55e;
    --accent-yellow: #eab308;
    --accent-red: #ef4444;
    --accent-orange: #f97316;
    --border: #334155;
}}

* {{ margin: 0; padding: 0; box-sizing: border-box; }}

body {{
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg-primary);
    color: var(--text);
    line-height: 1.6;
    padding: 2rem;
    max-width: 1400px;
    margin: 0 auto;
}}

header {{
    text-align: center;
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
}}

header h1 {{
    font-size: 2rem;
    background: linear-gradient(135deg, var(--accent-blue), var(--accent-cyan));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}}

.subtitle {{
    color: var(--text-muted);
    margin-top: 0.5rem;
}}

.section {{
    margin-bottom: 2rem;
}}

.section h2 {{
    color: var(--accent-cyan);
    font-size: 1.25rem;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
}}

.section p {{
    color: var(--text-muted);
    margin-bottom: 1rem;
    font-size: 0.9rem;
}}

.summary-grid, .safety-grid {{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
}}

.card {{
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
}}

.card-label {{
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.25rem;
}}

.card-value {{
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
}}

.card-sub {{
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
}}

.data-table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    background: var(--bg-secondary);
    border-radius: 8px;
    overflow: hidden;
}}

.data-table th {{
    background: rgba(51, 65, 85, 0.5);
    padding: 0.75rem 1rem;
    text-align: left;
    font-weight: 600;
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
}}

.data-table td {{
    padding: 0.6rem 1rem;
    border-top: 1px solid var(--border);
    white-space: nowrap;
}}

.data-table tr:hover {{
    background: rgba(51, 65, 85, 0.3);
}}

.data-table .num {{
    font-family: 'SF Mono', 'Fira Code', monospace;
    text-align: right;
}}

.data-table .rationale {{
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: normal;
    max-width: 400px;
}}

.badge {{
    display: inline-block;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #fff;
}}

.sortable th[data-sort] {{
    cursor: pointer;
    user-select: none;
}}
.sortable th[data-sort]:hover {{
    color: var(--accent-cyan);
}}
.sortable th.sort-asc::after {{ content: ' \\25B2'; }}
.sortable th.sort-desc::after {{ content: ' \\25BC'; }}

.safety-list {{
    list-style: none;
    margin-top: 0.5rem;
    font-size: 0.85rem;
}}
.safety-list li {{
    padding: 0.25rem 0;
    color: var(--text-muted);
}}
.safety-list li::before {{
    content: '\\2022 ';
    color: var(--accent-cyan);
}}

.token-group {{
    margin-bottom: 2rem;
}}
.token-group h3 {{
    color: var(--accent-blue);
    font-size: 1.1rem;
    margin-bottom: 1rem;
}}
.fee-curve-grid {{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
    gap: 1rem;
}}
.fee-curve-block {{
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
}}
.fee-curve-block h4 {{
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
    font-family: 'SF Mono', 'Fira Code', monospace;
}}
.fee-curve-table {{
    font-size: 0.8rem;
}}
.fee-curve-table td, .fee-curve-table th {{
    padding: 0.35rem 0.6rem;
}}

@media (max-width: 768px) {{
    body {{ padding: 1rem; }}
    .summary-grid {{ grid-template-columns: repeat(2, 1fr); }}
    .data-table {{ font-size: 0.75rem; }}
    .data-table th, .data-table td {{ padding: 0.4rem 0.5rem; }}
    .fee-curve-grid {{ grid-template-columns: 1fr; }}
}}
</style>
</head>
<body>
{body}

<footer style="text-align:center;color:var(--text-muted);font-size:0.75rem;margin-top:3rem;padding-top:1rem;border-top:1px solid var(--border);">
    Hyperlane Fee Autopilot &mdash; Generated {ts_str}
</footer>

<script>
document.querySelectorAll('.sortable').forEach(table => {{
    const headers = table.querySelectorAll('th[data-sort]');
    headers.forEach((header, colIdx) => {{
        header.addEventListener('click', () => {{
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            const sortType = header.dataset.sort;
            const isAsc = header.classList.contains('sort-asc');
            rows.sort((a, b) => {{
                let aVal = a.cells[colIdx].textContent.trim();
                let bVal = b.cells[colIdx].textContent.trim();
                if (sortType === 'num') {{
                    aVal = parseFloat(aVal.replace(/[$,%+bps\\s]/g, '').replace(/[—N\\/A]/g, '-999')) || -999;
                    bVal = parseFloat(bVal.replace(/[$,%+bps\\s]/g, '').replace(/[—N\\/A]/g, '-999')) || -999;
                }}
                if (aVal < bVal) return isAsc ? 1 : -1;
                if (aVal > bVal) return isAsc ? -1 : 1;
                return 0;
            }});
            headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
            header.classList.add(isAsc ? 'sort-desc' : 'sort-asc');
            rows.forEach(row => tbody.appendChild(row));
        }});
    }});
}});
</script>
</body>
</html>"""

"""Post fee recommendations to Slack after each scan."""

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError
except ImportError:
    WebClient = None
    SlackApiError = None

DATA_DIR = Path(__file__).parent.parent / "data"
LATEST_SCAN = DATA_DIR / "latest_scan.json"
LAST_MSG_TS_FILE = DATA_DIR / "slack_last_msg_ts.txt"


def post_scan_summary(scan_data: dict = None, config: dict = None) -> bool:
    """Post fee recommendation summary to Slack. Returns True on success."""
    if WebClient is None:
        logger.warning("slack_sdk not installed — skipping Slack post")
        return False

    slack_cfg = (config or {}).get("slack", {})
    if not slack_cfg.get("enabled"):
        return False

    token = slack_cfg.get("bot_token", "")
    channel = slack_cfg.get("channel", "")
    if not token or not channel:
        logger.warning("Slack bot_token or channel not configured")
        return False

    if scan_data is None:
        if not LATEST_SCAN.exists():
            logger.warning("No latest_scan.json to post")
            return False
        with open(LATEST_SCAN) as f:
            scan_data = json.load(f)

    blocks = _build_blocks(scan_data)
    fallback_text = "Hyperlane Fee Autopilot — Fee Recommendations"

    client = WebClient(token=token)

    try:
        # Update previous message if configured
        if slack_cfg.get("update_previous") and LAST_MSG_TS_FILE.exists():
            last_ts = LAST_MSG_TS_FILE.read_text().strip()
            if last_ts:
                try:
                    client.chat_update(
                        channel=channel, ts=last_ts,
                        text=fallback_text, blocks=blocks,
                    )
                    return True
                except Exception:
                    pass  # Fall through to post new message

        resp = client.chat_postMessage(
            channel=channel, text=fallback_text, blocks=blocks,
        )
        # Save message ts for future updates
        LAST_MSG_TS_FILE.parent.mkdir(parents=True, exist_ok=True)
        LAST_MSG_TS_FILE.write_text(resp["ts"])
        return True

    except Exception as e:
        logger.error(f"Slack post failed: {e}")
        return False


def _build_blocks(scan_data: dict) -> list[dict]:
    """Build Slack Block Kit blocks focused on fee recommendations."""
    blocks = []

    # Header
    ts = scan_data.get("timestamp")
    ts_str = ""
    if ts:
        dt = datetime.fromtimestamp(float(ts), tz=timezone.utc)
        ts_str = dt.strftime("%Y-%m-%d %H:%M UTC")

    safety = scan_data.get("safety", {})
    halted = safety.get("circuit_breaker", {}).get("halt", False)
    status = "HALTED" if halted else "ACTIVE"

    blocks.append({
        "type": "header",
        "text": {"type": "plain_text", "text": "Hyperlane Fee Autopilot"}
    })
    blocks.append({
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": f"Scan: {ts_str}  |  Status: *{status}*"}]
    })
    blocks.append({"type": "divider"})

    # IGP Recommended Fees ($ per destination)
    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": "*IGP Fees (recommended $ per destination)*"}
    })

    delivery_costs = scan_data.get("delivery_costs", {})
    igp_comparison = scan_data.get("igp_quote_comparison", {}).get("by_destination", {})

    igp_lines = []
    for chain in sorted(delivery_costs.keys()):
        cost = delivery_costs[chain]
        rec_usd = cost.get("igp_quote_usd")
        if rec_usd is None:
            continue

        current_usd = igp_comparison.get(chain, {}).get("current_median_usd")
        if current_usd is not None:
            delta = rec_usd - current_usd
            arrow = ""
            if abs(delta) > 0.01:
                arrow = " :arrow_up:" if delta > 0 else " :arrow_down:"
            igp_lines.append(
                f"`{chain:18s}` current *${current_usd:.4f}* → rec *${rec_usd:.4f}*{arrow}"
            )
        else:
            igp_lines.append(f"`{chain:18s}` rec *${rec_usd:.4f}*")

    if igp_lines:
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "\n".join(igp_lines)}
        })

    blocks.append({"type": "divider"})

    # Warp Route Fees (bps)
    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": "*Warp Route Fees (recommended bps)*"}
    })

    warp_recs = scan_data.get("warp_recommendations", {})

    # Short chain name map for compact display
    _short = {
        "ethereum": "eth", "arbitrum": "arb", "optimism": "op",
        "base": "base", "polygon": "poly", "unichain": "uni",
        "eclipsemainnet": "eclipse", "solanamainnet": "sol",
    }

    warp_lines = []
    for route, rec in sorted(warp_recs.items()):
        if rec.get("error"):
            continue
        parts = route.split("->")
        if len(parts) != 2:
            continue
        origin_full, dest = parts
        origin = origin_full.split(":")[-1] if ":" in origin_full else origin_full

        rec_bps = rec.get("recommended_bps")
        current_bps = rec.get("current_fee_bps")
        if rec_bps is None:
            continue

        src_short = _short.get(origin, origin[:6])
        dst_short = _short.get(dest, dest[:6])
        label = f"{src_short}→{dst_short}"

        current_str = f"{current_bps}" if current_bps is not None else "n/a"

        change = ""
        if current_bps is not None and current_bps != rec_bps:
            change = " :small_red_triangle_down:" if rec_bps < current_bps else " :small_red_triangle:"

        warp_lines.append(
            f"`{label:16s}` *{current_str}* → *{rec_bps}*{change}"
        )

    if warp_lines:
        # Slack has a 3000 char limit per text block — split if needed
        chunk = []
        chunk_len = 0
        for line in warp_lines:
            if chunk_len + len(line) + 1 > 2900 and chunk:
                blocks.append({
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": "\n".join(chunk)}
                })
                chunk = []
                chunk_len = 0
            chunk.append(line)
            chunk_len += len(line) + 1
        if chunk:
            blocks.append({
                "type": "section",
                "text": {"type": "mrkdwn", "text": "\n".join(chunk)}
            })

    blocks.append({"type": "divider"})

    # Competitive position (compact)
    comp = scan_data.get("competitive_summary", {})
    n_cheaper = comp.get("n_routes_cheaper", 0)
    n_competitive = comp.get("n_routes_competitive", 0)
    n_expensive = comp.get("n_routes_expensive", 0)
    n_total = comp.get("n_routes_analyzed", 0)
    position = comp.get("overall_position", "unknown")

    blocks.append({
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": (
            f"Competitive: *{position}* — "
            f"{n_cheaper} cheapest | {n_competitive} competitive | {n_expensive} expensive "
            f"(of {n_total} routes)"
        )}]
    })

    # Data source health — flag competitor APIs that failed
    coll_stats = scan_data.get("competitor_collection_stats", {})
    source_issues = []
    source_ok = []
    for name, stats in sorted(coll_stats.items()):
        ok = stats.get("ok", 0)
        total = stats.get("total", 0)
        if total == 0:
            continue
        if ok == 0:
            source_issues.append(f"{name} *0/{total}* :x:")
        elif ok < total * 0.5:
            source_issues.append(f"{name} *{ok}/{total}* :warning:")
        else:
            source_ok.append(f"{name} {ok}/{total}")

    if source_issues or source_ok:
        parts = source_issues + source_ok
        blocks.append({
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"Data sources: {' | '.join(parts)}"}]
        })

    # Safety alerts if any
    if halted:
        issues = safety.get("circuit_breaker", {}).get("issues", [])
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f":rotating_light: *CIRCUIT BREAKER*: {', '.join(issues)}"}
        })

    stale = safety.get("stale_sources", [])
    if stale:
        blocks.append({
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f":warning: Stale data: {', '.join(stale)}"}]
        })

    return blocks

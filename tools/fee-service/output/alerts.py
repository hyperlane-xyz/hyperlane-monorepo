"""Slack alerting via webhook."""

import os
import json
from typing import Optional

try:
    import requests
except ImportError:
    requests = None


def send_slack_alert(message: str, webhook_url: str = None,
                     blocks: list = None) -> bool:
    """Send an alert to Slack via webhook.

    Returns True if sent successfully.
    """
    if requests is None:
        print("  WARNING: requests not installed, cannot send Slack alert")
        return False

    url = webhook_url or os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        print("  INFO: No SLACK_WEBHOOK_URL configured, skipping alert")
        return False

    payload = {"text": message}
    if blocks:
        payload["blocks"] = blocks

    try:
        resp = requests.post(url, json=payload, timeout=10)
        return resp.status_code == 200
    except Exception as e:
        print(f"  WARNING: Failed to send Slack alert: {e}")
        return False


def format_igp_drift_alert(recommendations: dict) -> Optional[str]:
    """Format an alert for IGP parameters that need updating."""
    needs_update = []
    for route_key, rec in recommendations.items():
        if rec.get("needs_update"):
            gas_diff = rec.get("gas_price_diff_pct", 0) or 0
            token_diff = rec.get("token_price_diff_pct", 0) or 0
            max_diff = max(gas_diff, token_diff)
            needs_update.append((route_key, max_diff, rec))

    if not needs_update:
        return None

    needs_update.sort(key=lambda x: -x[1])

    lines = ["*IGP Fee Drift Alert*\n"]
    lines.append(f"{len(needs_update)} route(s) need IGP parameter updates:\n")
    for route_key, max_diff, rec in needs_update[:10]:
        gas_diff = rec.get("gas_price_diff_pct", "?")
        token_diff = rec.get("token_price_diff_pct", "?")
        lines.append(
            f"  `{route_key}` — gas price: {gas_diff}% drift, "
            f"token price: {token_diff}% drift"
        )

    return "\n".join(lines)


def format_safety_alert(circuit_breaker: dict) -> Optional[str]:
    """Format a circuit breaker alert."""
    if not circuit_breaker.get("halt"):
        return None

    lines = ["*CIRCUIT BREAKER TRIGGERED*\n"]
    lines.append("All automated fee updates halted:\n")
    for issue in circuit_breaker.get("issues", []):
        lines.append(f"  {issue}")

    return "\n".join(lines)


def format_competitive_alert(competitive_summary: dict, config: dict) -> Optional[str]:
    """Alert if competitive position changed significantly."""
    n_expensive = competitive_summary.get("n_routes_expensive", 0)
    n_total = competitive_summary.get("n_routes_analyzed", 0)

    if n_total == 0:
        return None

    expensive_pct = (n_expensive / n_total) * 100
    threshold = config.get("alerts", {}).get("competitor_change_pct", 50)

    if expensive_pct > threshold:
        return (
            f"*Competitive Position Warning*\n"
            f"Hyperlane is expensive on {n_expensive}/{n_total} routes "
            f"({expensive_pct:.0f}%). Review warp fee recommendations."
        )
    return None


def format_stale_data_alert(stale_sources: list) -> Optional[str]:
    """Alert if data sources are stale."""
    if not stale_sources:
        return None
    lines = ["*Stale Data Warning*\n"]
    for src in stale_sources:
        lines.append(f"  {src}")
    return "\n".join(lines)

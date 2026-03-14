"""Safety rails: bounds checking, circuit breakers, loss prevention."""

import time
from typing import Optional


class SafetyChecker:
    """Validate fee recommendations and halt if safety conditions are breached."""

    def __init__(self, config: dict):
        self.cfg = config.get("safety", {})
        self._price_history: dict[str, list[tuple[float, float]]] = {}  # token -> [(ts, price)]

    def check_igp_recommendation(self, rec: dict) -> dict:
        """Validate an IGP recommendation against safety bounds.

        Returns: {safe: bool, warnings: [...], blocked: bool, reason: str}
        """
        warnings = []
        blocked = False
        reason = None

        # Hard bounds on resulting USD cost
        # We'd need to compute the resulting quote, but we can check the params
        gas_price = rec.get("gas_price", 0)
        if gas_price <= 0:
            warnings.append(f"Gas price is 0 for {rec.get('remote_chain')}")

        # Check max change rate
        gas_diff = rec.get("gas_price_diff_pct")
        token_diff = rec.get("token_price_diff_pct")
        max_change = self.cfg.get("max_change_pct", 200)

        if gas_diff is not None and gas_diff > max_change:
            blocked = True
            reason = f"Gas price change {gas_diff:.0f}% exceeds max {max_change}%"
        if token_diff is not None and token_diff > max_change:
            blocked = True
            reason = f"Token price change {token_diff:.0f}% exceeds max {max_change}%"

        return {
            "safe": not blocked,
            "warnings": warnings,
            "blocked": blocked,
            "reason": reason,
        }

    def check_warp_recommendation(self, rec: dict, delivery_cost_usd: float) -> dict:
        """Validate a warp fee recommendation.

        Returns: {safe: bool, warnings: [...], blocked: bool, reason: str}
        """
        warnings = []
        blocked = False
        reason = None

        bps = rec.get("recommended_bps", 0)
        min_bps = self.cfg.get("warp_min_bps", 0)
        max_bps = self.cfg.get("warp_max_bps", 100)

        if bps < min_bps:
            blocked = True
            reason = f"Recommended {bps} bps below minimum {min_bps} bps"
        if bps > max_bps:
            blocked = True
            reason = f"Recommended {bps} bps above maximum {max_bps} bps"

        # Loss prevention: fee must cover delivery cost
        rec_usd = rec.get("recommended_usd", 0)
        if rec_usd < delivery_cost_usd and delivery_cost_usd > 0:
            warnings.append(
                f"Fee ${rec_usd:.4f} below delivery cost ${delivery_cost_usd:.4f}"
            )

        return {
            "safe": not blocked,
            "warnings": warnings,
            "blocked": blocked,
            "reason": reason,
        }

    def check_circuit_breakers(self, collector_results: dict,
                               token_prices: dict) -> dict:
        """Check system-wide circuit breakers.

        Conditions that halt all updates:
        1. >50% of data fetches failed
        2. Any token price moved >30% in 15 min
        """
        issues = []
        halt = False

        # Check data fetch success rate
        total = 0
        failed = 0
        for name, result in collector_results.items():
            if isinstance(result, dict):
                total += 1
                if not result or result.get("error"):
                    failed += 1
            elif result is None:
                total += 1
                failed += 1

        fail_threshold = self.cfg.get("circuit_breaker_fail_pct", 50) / 100
        if total > 0 and (failed / total) > fail_threshold:
            halt = True
            issues.append(f"{failed}/{total} data sources failed (>{fail_threshold:.0%} threshold)")

        # Check token price volatility
        price_move_threshold = self.cfg.get("circuit_breaker_price_move_pct", 30) / 100
        now = time.time()

        for token, price_data in token_prices.items():
            if not isinstance(price_data, dict):
                continue
            current_price = price_data.get("usd")
            if current_price is None:
                continue

            # Track price history
            if token not in self._price_history:
                self._price_history[token] = []
            self._price_history[token].append((now, current_price))

            # Prune old entries (keep last 60 min)
            self._price_history[token] = [
                (ts, p) for ts, p in self._price_history[token]
                if now - ts < 3600
            ]

            # Check 15-min window
            recent = [
                (ts, p) for ts, p in self._price_history[token]
                if now - ts < 900  # 15 min
            ]
            if len(recent) >= 2:
                oldest_price = recent[0][1]
                if oldest_price > 0:
                    move = abs(current_price - oldest_price) / oldest_price
                    if move > price_move_threshold:
                        halt = True
                        issues.append(
                            f"{token} price moved {move:.0%} in 15 min "
                            f"(${oldest_price:.2f} -> ${current_price:.2f})"
                        )

        return {
            "halt": halt,
            "issues": issues,
            "data_sources_total": total,
            "data_sources_failed": failed,
        }

    def check_staleness(self, timestamps: dict) -> list:
        """Check if any data sources are stale (>60 min old).

        timestamps: {source_name: last_update_epoch}
        """
        stale_limit = self.cfg.get("stale_data_minutes", 60) * 60
        now = time.time()
        stale = []
        for source, ts in timestamps.items():
            if ts and (now - ts) > stale_limit:
                age_min = (now - ts) / 60
                stale.append(f"{source}: {age_min:.0f} min old")
        return stale

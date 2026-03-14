"""Rebalancing cost model — aggregate tx data into per-route-pair cost in bps.

This module provides the RebalancingCostProvider, which computes the
amortized cost of rebalancing liquidity for each route-pair. This cost
feeds into the fee recommender as a floor: warp fees should at minimum
cover delivery cost + rebalancing cost.

Data sources (in priority order):
  1. Live rebalancer API (future — when smart rebalancer at ~/selfrelay connects)
  2. On-chain tx history (current — from collectors/rebalancing.py)
  3. Config fallback (always available — static bps estimate per route-pair)
"""

import time
from typing import Optional


class RebalancingCostProvider:
    """Provides rebalancing cost estimates for route-pairs.

    Usage:
        provider = RebalancingCostProvider(config)
        provider.update_from_tx_data(tx_data)  # from collectors
        cost = provider.get_cost("ethereum", "arbitrum")
        # Returns: {"bps": 1.2, "source": "on_chain", ...}
    """

    def __init__(self, config: dict):
        rebal_cfg = config.get("rebalancing", {})
        self.fallback_bps = rebal_cfg.get("fallback_default_bps", 1.5)
        self.lookback_days = rebal_cfg.get("lookback_days", 30)
        self.route_overrides = rebal_cfg.get("route_overrides", {})

        # Computed from on-chain data
        self._route_costs: dict[str, dict] = {}
        # Live data from rebalancer API (future)
        self._live_costs: dict[str, dict] = {}

    def update_from_tx_data(self, rebalancing_data: dict,
                            volume_data: dict = None):
        """Compute per-route rebalancing costs from collected tx data.

        Args:
            rebalancing_data: Output from RebalancingCollector.collect()
            volume_data: Optional per-route volume for the same period.
                         If not provided, uses total rebalanced amount as proxy.
        """
        txs = rebalancing_data.get("transactions", [])
        if not txs:
            return

        cutoff = time.time() - (self.lookback_days * 86400)

        # Group costs by source chain (rebalancing FROM that chain)
        chain_costs: dict[str, dict] = {}

        for tx in txs:
            if tx.get("is_error"):
                continue
            if tx.get("timestamp", 0) < cutoff:
                continue

            chain = tx["chain"]
            gas_cost_usd = tx.get("gas_cost_usd", 0)
            amount_usd = tx.get("amount_usd", 0)

            if chain not in chain_costs:
                chain_costs[chain] = {
                    "total_gas_cost_usd": 0,
                    "total_amount_usd": 0,
                    "tx_count": 0,
                }

            chain_costs[chain]["total_gas_cost_usd"] += gas_cost_usd
            chain_costs[chain]["total_amount_usd"] += amount_usd
            chain_costs[chain]["tx_count"] += 1

        # Compute per-chain rebalancing cost in bps
        for chain, data in chain_costs.items():
            total_vol = data["total_amount_usd"]
            total_cost = data["total_gas_cost_usd"]

            if total_vol > 0:
                # Cost as bps of volume rebalanced
                cost_bps = (total_cost / total_vol) * 10000
            else:
                cost_bps = self.fallback_bps

            # Store as "from this chain" cost — applies to all routes
            # originating from this chain
            self._route_costs[chain] = {
                "bps": round(cost_bps, 3),
                "total_gas_cost_usd": round(total_cost, 2),
                "total_volume_usd": round(total_vol, 2),
                "tx_count": data["tx_count"],
                "source": "on_chain",
                "lookback_days": self.lookback_days,
            }

    def update_from_live_api(self, live_data: dict):
        """Update costs from the smart rebalancer's live API.

        Expected format:
        {
            "route_costs": {
                "ethereum->arbitrum": {"bps": 0.8, "confidence": 0.95},
                ...
            },
            "timestamp": 1234567890
        }
        """
        for route_key, cost_data in live_data.get("route_costs", {}).items():
            self._live_costs[route_key] = {
                "bps": cost_data.get("bps", self.fallback_bps),
                "source": "live_rebalancer",
                "confidence": cost_data.get("confidence", 1.0),
                "timestamp": live_data.get("timestamp", time.time()),
            }

    def get_cost(self, src_chain: str, dst_chain: str) -> dict:
        """Get rebalancing cost for a route-pair.

        Priority:
          1. Live rebalancer data (if connected)
          2. On-chain tx analysis
          3. Route-specific config override
          4. Global fallback
        """
        route_key = f"{src_chain}->{dst_chain}"

        # 1. Live rebalancer
        if route_key in self._live_costs:
            return self._live_costs[route_key]

        # 2. On-chain data (use destination chain as proxy — rebalancing
        #    flows TO the chain that receives bridge transfers)
        if dst_chain in self._route_costs:
            return self._route_costs[dst_chain]

        # Also check source chain
        if src_chain in self._route_costs:
            return self._route_costs[src_chain]

        # 3. Route-specific override from config
        if route_key in self.route_overrides:
            return {
                "bps": self.route_overrides[route_key],
                "source": "config_override",
            }

        # 4. Global fallback
        return {
            "bps": self.fallback_bps,
            "source": "fallback",
        }

    def get_all_costs(self) -> dict:
        """Return all computed rebalancing costs for dashboard display."""
        result = {}

        # On-chain computed
        for chain, data in self._route_costs.items():
            result[chain] = data

        # Live overrides
        for route_key, data in self._live_costs.items():
            result[route_key] = data

        return result

    def is_connected(self) -> bool:
        """Check if live rebalancer data is available."""
        if not self._live_costs:
            return False
        # Check staleness — consider disconnected if >30 min old
        for data in self._live_costs.values():
            if time.time() - data.get("timestamp", 0) < 1800:
                return True
        return False

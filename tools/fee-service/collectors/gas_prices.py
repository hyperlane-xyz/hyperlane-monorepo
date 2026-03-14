"""Collect live gas prices from EVM RPCs and Solana."""

from typing import Optional
from .base import BaseCollector


class GasPriceCollector(BaseCollector):
    """Fetch current gas prices for all configured chains."""

    def __init__(self, config: dict):
        super().__init__()
        self.chains = config["chains"]
        self._cache_ttl = 120  # 2 min cache for gas

    def collect(self) -> dict:
        """Return {chain_name: {gas_price_wei, gas_price_gwei, type}} for all chains."""
        results = {}
        for name, chain in self.chains.items():
            cached = self._get_cached(f"gas:{name}")
            if cached is not None:
                results[name] = cached
                continue

            if chain["type"] == "sealevel":
                data = self._fetch_solana_gas(chain, name)
            else:
                data = self._fetch_evm_gas(name, chain)

            if data:
                results[name] = data
                self._set_cached(f"gas:{name}", data)
            else:
                print(f"  WARNING: Failed to fetch gas for {name}")
        return results

    def _fetch_evm_gas(self, name: str, chain: dict) -> Optional[dict]:
        """Fetch gas price via eth_gasPrice RPC."""
        rpc_url = chain.get("rpc")
        if not rpc_url:
            return None

        result = self.rpc_call(rpc_url, "eth_gasPrice", [])
        if result is None:
            return None

        gas_price_wei = int(result, 16)
        gas_price_gwei = gas_price_wei / 1e9

        # For L2s, also try to get L1 data fee estimate
        l1_fee_scalar = None
        if chain.get("l2"):
            l1_fee_scalar = self._estimate_l1_fee_scalar(name, chain)

        return {
            "gas_price_wei": gas_price_wei,
            "gas_price_gwei": gas_price_gwei,
            "l1_fee_scalar": l1_fee_scalar,
            "type": "evm",
            "chain": name,
        }

    def _estimate_l1_fee_scalar(self, name: str, chain: dict) -> Optional[float]:
        """Estimate L1 data posting cost multiplier for L2 chains.

        Uses the GasPriceOracle precompile at 0x420...00F on OP-stack chains.
        l1BaseFee() selector: 0x519b4bd3
        """
        rpc_url = chain.get("rpc")
        if not rpc_url:
            return None

        # OP-stack GasPriceOracle at 0x420000000000000000000000000000000000000F
        oracle = "0x420000000000000000000000000000000000000F"
        # l1BaseFee() → uint256
        result = self.rpc_call(rpc_url, "eth_call",
                               [{"to": oracle, "data": "0x519b4bd3"}, "latest"])
        if result and result != "0x":
            try:
                l1_base_fee_wei = int(result, 16)
                # Return as gwei for readability
                return l1_base_fee_wei / 1e9
            except (ValueError, TypeError):
                pass
        return None

    def _fetch_solana_gas(self, chain: dict, name: str = None) -> Optional[dict]:
        """Fetch Solana/SVM priority fees.

        Priority fee sources (in order of preference):
        1. Helius getPriorityFeeEstimate API (Solana mainnet, requires helius_rpc)
        2. Per-chain constant from config (priority_fee_microlamports)
        3. On-chain getRecentPrioritizationFees RPC (fallback)
        """
        rpc_url = chain.get("rpc")
        if not rpc_url:
            return None

        priority_fee = None
        fee_source = None

        # 1. Try Helius API if configured
        helius_rpc = chain.get("helius_rpc", "")
        if helius_rpc:
            priority_fee = self._fetch_helius_priority_fee(helius_rpc)
            if priority_fee is not None:
                fee_source = "helius"

        # 2. Use per-chain constant if configured and Helius unavailable
        if priority_fee is None and chain.get("priority_fee_microlamports") is not None:
            priority_fee = chain["priority_fee_microlamports"]
            fee_source = "config"

        # 3. Fall back to on-chain RPC
        if priority_fee is None:
            result = self.rpc_call(rpc_url, "getRecentPrioritizationFees", [])
            if result and isinstance(result, list) and len(result) > 0:
                fees = sorted(entry.get("prioritizationFee", 0) for entry in result)
                priority_fee = fees[int(len(fees) * 0.75)]
                fee_source = "rpc"
            else:
                priority_fee = 0
                fee_source = "default"

        return {
            "base_fee_lamports": 5000,  # 5000 lamports per signature
            "priority_fee_microlamports": priority_fee,
            "priority_fee_source": fee_source,
            "type": "sealevel",
            "chain": name or "solanamainnet",
        }

    def _fetch_helius_priority_fee(self, helius_rpc: str) -> Optional[int]:
        """Fetch priority fee estimate from Helius API (High level)."""
        try:
            result = self.rpc_call(
                helius_rpc,
                "getPriorityFeeEstimate",
                [{"options": {"priorityLevel": "High"}}],
            )
            if result and isinstance(result, dict):
                fee = result.get("priorityFeeEstimate")
                if fee is not None:
                    return int(fee)
        except Exception as e:
            print(f"  Helius priority fee fetch failed: {e}")
        return None

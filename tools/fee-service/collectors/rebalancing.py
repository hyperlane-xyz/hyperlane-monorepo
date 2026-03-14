"""Collect rebalancing transaction history from block explorer APIs.

Fetches ERC-20 token transfers and normal transactions for rebalancer
addresses across configured chains. Computes gas cost and bridge fee
for each rebalancing event.

Discovery findings (Feb 2026):
  - Main rebalancer (0xa394...): calls rebalance() on HypERC20Collateral
    via CCTP. ~25-40 txs/day, $3-225 USDC per tx.
  - Inventory rebalancer (0x6056...): moves ETH via transferRemote()
    and LiFi/Stargate.
  - Gas costs are very low (~$5-10/day total across all chains).
"""

import time
from datetime import datetime, timezone
from .base import BaseCollector

# USDC contract addresses per chain
USDC_ADDRESSES = {
    "ethereum": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "arbitrum": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "optimism": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    "polygon": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "unichain": "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
}

# Block explorer API base URLs (Etherscan-compatible)
EXPLORER_APIS = {
    "ethereum": "https://api.etherscan.io/api",
    "arbitrum": "https://api.arbiscan.io/api",
    "base": "https://api.basescan.org/api",
    "optimism": "https://api-optimistic.etherscan.io/api",
    "polygon": "https://api.polygonscan.com/api",
}


class RebalancingCollector(BaseCollector):
    """Collect rebalancing transaction data from block explorers."""

    # Slower rate limit for free-tier block explorers (5 calls/sec max)
    MIN_REQUEST_INTERVAL = 0.25

    def __init__(self, config: dict):
        super().__init__()
        self._cache_ttl = 900  # 15 min cache — rebalancing data is slow-moving
        rebal_cfg = config.get("rebalancing", {})
        self.addresses = rebal_cfg.get("addresses", {})
        self.chains = rebal_cfg.get("chains", [])
        self.lookback_days = rebal_cfg.get("lookback_days", 30)
        self.api_keys = rebal_cfg.get("api_keys", {})

    def collect(self, token_prices: dict = None) -> dict:
        """Collect rebalancing txs for all configured addresses and chains.

        Returns: {
            "transactions": [
                {
                    "address_role": "main" | "inventory",
                    "address": "0x...",
                    "chain": "ethereum",
                    "tx_hash": "0x...",
                    "timestamp": 1234567890,
                    "method": "rebalance" | "transferRemote" | "unknown",
                    "token": "USDC" | "ETH",
                    "amount_raw": 123456,
                    "amount_usd": 123.45,
                    "gas_used": 200000,
                    "gas_price_wei": 30000000000,
                    "gas_cost_native": 0.006,
                    "gas_cost_usd": 15.00,
                    "to_contract": "0x...",
                    "destination_domain": 42161,
                },
                ...
            ],
            "summary": {
                "total_txs": 100,
                "total_gas_cost_usd": 50.0,
                "chains_scanned": ["ethereum", "arbitrum", "base"],
                "lookback_days": 30,
            }
        }
        """
        token_prices = token_prices or {}
        all_txs = []

        for role, address in self.addresses.items():
            if not address:
                continue
            for chain in self.chains:
                if chain not in EXPLORER_APIS:
                    continue

                print(f"  Fetching {role} rebalancer txs on {chain}...")
                txs = self._fetch_chain_txs(
                    chain, address, role, token_prices
                )
                all_txs.extend(txs)

        # Compute summary
        total_gas_usd = sum(tx.get("gas_cost_usd", 0) for tx in all_txs)
        chains_scanned = list(set(tx["chain"] for tx in all_txs)) if all_txs else []

        return {
            "transactions": all_txs,
            "summary": {
                "total_txs": len(all_txs),
                "total_gas_cost_usd": round(total_gas_usd, 2),
                "chains_scanned": sorted(chains_scanned),
                "lookback_days": self.lookback_days,
                "timestamp": time.time(),
            },
        }

    def _fetch_chain_txs(self, chain: str, address: str,
                         role: str, token_prices: dict) -> list:
        """Fetch normal + token txs for an address on a chain."""
        base_url = EXPLORER_APIS[chain]
        api_key = self.api_keys.get(chain, "")
        native_token = "ethereum" if chain != "polygon" else "polygon"
        native_price = token_prices.get(native_token, {}).get("usd", 0)

        # Calculate start block timestamp
        cutoff_ts = int(time.time()) - (self.lookback_days * 86400)

        txs = []

        # 1. Normal transactions (gas costs, method IDs)
        normal_txs = self._fetch_explorer(
            base_url, "txlist", address, api_key
        )

        # 2. ERC-20 token transfers
        token_txs = self._fetch_explorer(
            base_url, "tokentx", address, api_key
        )

        # Index token txs by tx hash for join
        token_by_hash = {}
        for ttx in token_txs:
            h = ttx.get("hash", "")
            token_by_hash.setdefault(h, []).append(ttx)

        # Process normal txs
        usdc_addr = USDC_ADDRESSES.get(chain, "").lower()

        for ntx in normal_txs:
            ts = int(ntx.get("timeStamp", 0))
            if ts < cutoff_ts:
                continue

            tx_hash = ntx.get("hash", "")
            gas_used = int(ntx.get("gasUsed", 0))
            gas_price = int(ntx.get("gasPrice", 0))
            gas_cost_native = (gas_used * gas_price) / 1e18
            gas_cost_usd = gas_cost_native * native_price

            # Detect method
            method_id = ntx.get("functionName", "") or ntx.get("input", "")[:10]
            method = _classify_method(method_id)

            # Look up token transfers in this tx
            token_transfers = token_by_hash.get(tx_hash, [])
            usdc_transfer = None
            for tt in token_transfers:
                if tt.get("contractAddress", "").lower() == usdc_addr:
                    usdc_transfer = tt
                    break

            # Determine amount
            if usdc_transfer:
                token_symbol = "USDC"
                decimals = int(usdc_transfer.get("tokenDecimal", 6))
                amount_raw = int(usdc_transfer.get("value", 0))
                amount_usd = amount_raw / (10 ** decimals)
            else:
                # ETH value transfer
                value_wei = int(ntx.get("value", 0))
                if value_wei > 0:
                    token_symbol = "ETH"
                    amount_raw = value_wei
                    amount_usd = (value_wei / 1e18) * native_price
                else:
                    token_symbol = "unknown"
                    amount_raw = 0
                    amount_usd = 0

            txs.append({
                "address_role": role,
                "address": address,
                "chain": chain,
                "tx_hash": tx_hash,
                "timestamp": ts,
                "method": method,
                "token": token_symbol,
                "amount_raw": amount_raw,
                "amount_usd": round(amount_usd, 4),
                "gas_used": gas_used,
                "gas_price_wei": gas_price,
                "gas_cost_native": round(gas_cost_native, 8),
                "gas_cost_usd": round(gas_cost_usd, 4),
                "to_contract": ntx.get("to", ""),
                "is_error": ntx.get("isError", "0") != "0",
            })

        return txs

    def _fetch_explorer(self, base_url: str, action: str,
                        address: str, api_key: str = "") -> list:
        """Fetch from an Etherscan-compatible API."""
        cache_key = f"{base_url}:{action}:{address}"
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        params = {
            "module": "account",
            "action": action,
            "address": address,
            "startblock": 0,
            "endblock": 99999999,
            "sort": "desc",
            "page": 1,
            "offset": 200,  # Get last 200 txs
        }
        if api_key:
            params["apikey"] = api_key

        data = self.fetch_json(base_url, params=params)
        if data and data.get("status") == "1":
            result = data.get("result", [])
            self._set_cached(cache_key, result)
            return result

        # Some explorers return "0" status with empty result for valid empty sets
        return []


def _classify_method(method_str: str) -> str:
    """Classify a transaction method from function name or input data."""
    method_str = method_str.lower()
    if "rebalance" in method_str:
        return "rebalance"
    if "transferremote" in method_str:
        return "transferRemote"
    if "swapandstartbridge" in method_str:
        return "lifi_bridge"
    if "transfer" in method_str:
        return "transfer"
    # Method ID signatures
    if method_str.startswith("0x"):
        known = {
            "0x5b589b5d": "rebalance",
            "0xd77a5897": "transferRemote",
        }
        return known.get(method_str[:10], "unknown")
    return "unknown"

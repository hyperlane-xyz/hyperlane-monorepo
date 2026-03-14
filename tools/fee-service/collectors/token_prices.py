"""Collect token prices from CoinGecko (primary) and DefiLlama (fallback)."""

from typing import Optional
from .base import BaseCollector

COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price"
DEFILLAMA_API = "https://coins.llama.fi/prices/current"


class TokenPriceCollector(BaseCollector):
    """Fetch USD prices for native and transfer tokens."""

    def __init__(self, config: dict):
        super().__init__()
        self.tokens = config.get("tokens", {})
        self._cache_ttl = 300  # 5 min

    def collect(self) -> dict:
        """Return {token_key: {usd, source, coingecko_id}} for all tokens."""
        cached = self._get_cached("all_prices")
        if cached is not None:
            return cached

        # Try CoinGecko batch first
        prices = self._fetch_coingecko_batch()

        # Fill gaps with DefiLlama
        missing = [k for k, v in self.tokens.items() if k not in prices]
        if missing:
            llama_prices = self._fetch_defillama(missing)
            prices.update(llama_prices)

        if prices:
            self._set_cached("all_prices", prices)
        return prices

    def _fetch_coingecko_batch(self) -> dict:
        """Batch fetch all token prices from CoinGecko."""
        id_map = {}  # coingecko_id -> token_key
        for key, token in self.tokens.items():
            cg_id = token.get("coingecko_id")
            if cg_id:
                id_map[cg_id] = key

        if not id_map:
            return {}

        ids_str = ",".join(id_map.keys())
        data = self.fetch_json(COINGECKO_API, params={"ids": ids_str, "vs_currencies": "usd"})
        if not data:
            print("  WARNING: CoinGecko batch fetch failed")
            return {}

        results = {}
        for cg_id, key in id_map.items():
            if cg_id in data and "usd" in data[cg_id]:
                results[key] = {
                    "usd": data[cg_id]["usd"],
                    "source": "coingecko",
                    "coingecko_id": cg_id,
                }
        return results

    def _fetch_defillama(self, missing_keys: list) -> dict:
        """Fallback: fetch from DefiLlama coins API."""
        results = {}
        for key in missing_keys:
            token = self.tokens.get(key, {})
            cg_id = token.get("coingecko_id")
            if not cg_id:
                continue

            coin_id = f"coingecko:{cg_id}"
            data = self.fetch_json(f"{DEFILLAMA_API}/{coin_id}")
            if data and "coins" in data and coin_id in data["coins"]:
                price = data["coins"][coin_id].get("price")
                if price:
                    results[key] = {
                        "usd": price,
                        "source": "defillama",
                        "coingecko_id": cg_id,
                    }
        return results

    def get_price(self, token_key: str) -> Optional[float]:
        """Get a single token's USD price from cache or fresh fetch."""
        prices = self.collect()
        entry = prices.get(token_key)
        return entry["usd"] if entry else None

    def get_exchange_rate(self, remote_native: str, local_native: str) -> Optional[float]:
        """Compute token exchange rate: remote_price / local_price."""
        prices = self.collect()
        remote = prices.get(remote_native)
        local = prices.get(local_native)
        if not remote or not local or local["usd"] == 0:
            return None
        return remote["usd"] / local["usd"]

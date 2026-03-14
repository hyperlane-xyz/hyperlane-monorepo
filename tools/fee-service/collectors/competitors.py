"""Collect competitor bridge fee quotes.

EVM competitors: Across, Relay, LI.FI
Solana competitors: deBridge (DLN), Mayan Finance

Phased collection order (fastest/most reliable first):
  1. Across — fast GET API, no rate limits (EVM only)
  2. Relay — POST API, needs correct body format (EVM only)
  3. deBridge — GET API, supports EVM + Solana
  4. Mayan — GET API, supports EVM + Solana
  5. LI.FI — aggressive rate limiting, do last (EVM only)
"""

import time
from typing import Optional
from .base import BaseCollector

# Token addresses per chain for quoting
TOKEN_ADDRESSES = {
    "USDC": {
        1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        130: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    },
    "USDT": {
        1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        42161: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        10: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    },
    "ETH": {
        1: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        42161: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        10: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        8453: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    },
}

# WETH addresses for Across (uses WETH not native ETH)
WETH_ADDRESSES = {
    1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    10: "0x4200000000000000000000000000000000000006",
    8453: "0x4200000000000000000000000000000000000006",
    137: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    130: "0x4200000000000000000000000000000000000006",
}

# Solana token addresses
SOLANA_TOKEN_ADDRESSES = {
    "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}

# deBridge chain IDs (EVM chain IDs + Solana special ID)
DEBRIDGE_SOLANA_CHAIN_ID = 7565164

# Mayan chain names
MAYAN_CHAIN_NAMES = {
    1: "ethereum",
    42161: "arbitrum",
    10: "optimism",
    8453: "base",
    137: "polygon",
    130: "unichain",
    "solanamainnet": "solana",
}


class CompetitorCollector(BaseCollector):
    """Fetch bridge fee quotes from competitors at various transfer sizes."""

    def __init__(self, config: dict):
        super().__init__()
        self.config = config
        self.amounts_usd = config.get("quote_amounts_usd",
                                      [500, 1000, 5000, 10000, 20000, 50000, 100000, 300000])
        self.DEFAULT_TIMEOUT = int(config.get("collector_timeout", self.DEFAULT_TIMEOUT))
        self.DEFAULT_RETRIES = int(config.get("collector_retries", self.DEFAULT_RETRIES))
        self._cache_ttl = 600

    def collect(self, routes: list, token_prices: dict) -> dict:
        """Collect quotes for all routes, phased by competitor."""
        enabled = {
            str(name).lower()
            for name in self.config.get(
                "enabled_competitors",
                ["across", "relay", "debridge", "mayan", "lifi"],
            )
        }
        # Build EVM route pairs
        evm_pairs = []
        # Build Solana route pairs (EVM <-> Solana)
        solana_pairs = []

        for route in routes:
            token = route["token"]
            chains = route["chains"]
            for i, src in enumerate(chains):
                for dst in chains:
                    if src == dst:
                        continue
                    src_cfg = self.config["chains"].get(src, {})
                    dst_cfg = self.config["chains"].get(dst, {})
                    src_cid = src_cfg.get("chain_id")
                    dst_cid = dst_cfg.get("chain_id")
                    src_type = src_cfg.get("type", "evm")
                    dst_type = dst_cfg.get("type", "evm")

                    if src_type == "evm" and dst_type == "evm" and src_cid and dst_cid:
                        evm_pairs.append((token, src, dst, src_cid, dst_cid))
                    elif src_type == "evm" and dst_type == "sealevel" and src_cid:
                        solana_pairs.append((token, src, dst, src_cid, "solana"))
                    elif src_type == "sealevel" and dst_type == "evm" and dst_cid:
                        solana_pairs.append((token, src, dst, "solana", dst_cid))

        # Deduplicate EVM pairs (old code added both directions via i+1 slice)
        seen = set()
        deduped_evm = []
        for p in evm_pairs:
            key = (p[0], p[1], p[2])
            if key not in seen:
                seen.add(key)
                deduped_evm.append(p)
        evm_pairs = deduped_evm

        # Init results for all pairs
        results = {}
        for t, s, d, _, _ in evm_pairs:
            results.setdefault(f"{t}:{s}->{d}", {})
        for t, s, d, _, _ in solana_pairs:
            results.setdefault(f"{t}:{s}->{d}", {})

        total_evm = len(evm_pairs)
        total_sol = len(solana_pairs)

        # Collection stats — track success/total per competitor
        self._collection_stats = {}

        # Phase 1: Across (EVM only)
        print(f"    Phase 1: Across ({total_evm} EVM routes)...")
        across_ok = 0
        if "across" in enabled:
            for idx, (token, src, dst, src_cid, dst_cid) in enumerate(evm_pairs):
                key = f"{token}:{src}->{dst}"
                quotes = self._fetch_across(token, src_cid, dst_cid, token_prices)
                if quotes:
                    results[key]["across"] = quotes
                    across_ok += 1
                if (idx + 1) % 10 == 0:
                    print(f"      {idx + 1}/{total_evm} routes...")
        else:
            print("      skipped")
        print(f"    Across: {across_ok}/{total_evm} routes OK")
        self._collection_stats["across"] = {"ok": across_ok, "total": total_evm}

        # Phase 2: Relay (EVM only)
        print(f"    Phase 2: Relay ({total_evm} EVM routes)...")
        relay_ok = 0
        if "relay" in enabled:
            for idx, (token, src, dst, src_cid, dst_cid) in enumerate(evm_pairs):
                key = f"{token}:{src}->{dst}"
                quotes = self._fetch_relay(token, src_cid, dst_cid, token_prices)
                if quotes:
                    results[key]["relay"] = quotes
                    relay_ok += 1
                if (idx + 1) % 10 == 0:
                    print(f"      {idx + 1}/{total_evm} routes...")
        else:
            print("      skipped")
        print(f"    Relay: {relay_ok}/{total_evm} routes OK")
        self._collection_stats["relay"] = {"ok": relay_ok, "total": total_evm}

        # Phase 3: deBridge (EVM + Solana)
        all_debridge_pairs = evm_pairs + solana_pairs
        total_db = len(all_debridge_pairs)
        print(f"    Phase 3: deBridge ({total_db} routes incl. Solana)...")
        debridge_ok = 0
        if "debridge" in enabled:
            for idx, (token, src, dst, src_cid, dst_cid) in enumerate(all_debridge_pairs):
                key = f"{token}:{src}->{dst}"
                quotes = self._fetch_debridge(token, src_cid, dst_cid, token_prices)
                if quotes:
                    results[key]["debridge"] = quotes
                    debridge_ok += 1
                if (idx + 1) % 10 == 0:
                    print(f"      {idx + 1}/{total_db} routes...")
        else:
            print("      skipped")
        print(f"    deBridge: {debridge_ok}/{total_db} routes OK")
        self._collection_stats["debridge"] = {"ok": debridge_ok, "total": total_db}

        # Phase 4: Mayan (Solana routes only — EVM<->Solana)
        mayan_ok = 0
        if solana_pairs and "mayan" in enabled:
            print(f"    Phase 4: Mayan ({total_sol} Solana routes)...")
            for idx, (token, src, dst, src_cid, dst_cid) in enumerate(solana_pairs):
                key = f"{token}:{src}->{dst}"
                quotes = self._fetch_mayan(token, src, dst, src_cid, dst_cid, token_prices)
                if quotes:
                    results[key]["mayan"] = quotes
                    mayan_ok += 1
            print(f"    Mayan: {mayan_ok}/{total_sol} routes OK")
        self._collection_stats["mayan"] = {"ok": mayan_ok, "total": total_sol}

        # Phase 5: LI.FI (EVM only, best-effort)
        print(f"    Phase 5: LI.FI (best-effort, will bail on rate limits)...")
        lifi_ok = 0
        lifi_rate_limit_streak = 0
        if "lifi" in enabled:
            for idx, (token, src, dst, src_cid, dst_cid) in enumerate(evm_pairs):
                if lifi_rate_limit_streak >= 3:
                    print(f"    LI.FI: stopping after 3 consecutive rate-limited routes")
                    break
                key = f"{token}:{src}->{dst}"
                quotes, was_limited = self._fetch_lifi(token, src_cid, dst_cid, token_prices)
                if quotes:
                    results[key]["lifi"] = quotes
                    lifi_ok += 1
                    lifi_rate_limit_streak = 0
                elif was_limited:
                    lifi_rate_limit_streak += 1
                if (idx + 1) % 5 == 0:
                    print(f"      {idx + 1}/{total_evm} routes...")
        else:
            print("      skipped")
        print(f"    LI.FI: {lifi_ok}/{total_evm} routes OK")
        self._collection_stats["lifi"] = {"ok": lifi_ok, "total": total_evm}

        # Copy Solana competitor data to Eclipse routes
        # (no competitors support Eclipse directly, but Solana fees are a good proxy)
        self._mirror_solana_to_eclipse(results)

        return results

    def get_collection_stats(self) -> dict:
        """Return per-competitor collection stats from the last collect() call."""
        return getattr(self, "_collection_stats", {})

    def _mirror_solana_to_eclipse(self, results: dict):
        """Copy Solana competitor quotes to equivalent Eclipse routes."""
        solana_keys = [k for k in results if "solanamainnet" in k]
        for sol_key in solana_keys:
            eclipse_key = sol_key.replace("solanamainnet", "eclipsemainnet")
            if eclipse_key not in results or not results[eclipse_key]:
                results[eclipse_key] = {}
            for competitor, quotes in results[sol_key].items():
                if competitor not in results[eclipse_key]:
                    # Tag as mirrored from Solana
                    mirrored = {}
                    for size, q in quotes.items():
                        mq = dict(q)
                        mq["source"] = f"{mq.get('source', competitor)}_solana_proxy"
                        mirrored[size] = mq
                    results[eclipse_key][competitor] = mirrored

    def _fetch_debridge(self, token: str, src_chain, dst_chain,
                        token_prices: dict) -> Optional[dict]:
        """Fetch deBridge DLN quotes. Supports EVM chain IDs + Solana (7565164)."""
        # Resolve chain IDs for deBridge
        src_db = DEBRIDGE_SOLANA_CHAIN_ID if src_chain == "solana" else src_chain
        dst_db = DEBRIDGE_SOLANA_CHAIN_ID if dst_chain == "solana" else dst_chain

        cache_key = f"debridge:{token}:{src_db}:{dst_db}"
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        # Resolve token addresses
        if src_chain == "solana":
            src_addr = SOLANA_TOKEN_ADDRESSES.get(token)
        else:
            src_addr = TOKEN_ADDRESSES.get(token, {}).get(src_chain)

        if dst_chain == "solana":
            dst_addr = SOLANA_TOKEN_ADDRESSES.get(token)
        else:
            dst_addr = TOKEN_ADDRESSES.get(token, {}).get(dst_chain)

        if not src_addr or not dst_addr:
            return None

        token_decimals = 6  # USDC/USDT
        results = {}

        for amount_usd in self.amounts_usd:
            amount_raw = int(amount_usd * (10 ** token_decimals))

            data = self.fetch_json(
                "https://dln.debridge.finance/v1.0/dln/order/create-tx",
                params={
                    "srcChainId": str(src_db),
                    "srcChainTokenIn": src_addr,
                    "srcChainTokenInAmount": str(amount_raw),
                    "dstChainId": str(dst_db),
                    "dstChainTokenOut": dst_addr,
                    "dstChainTokenOutAmount": "auto",
                    "prependOperatingExpenses": "true",
                },
                retries=1,
            )
            if data and "estimation" in data:
                est = data["estimation"]
                src_val = float(est.get("srcChainTokenIn", {}).get("approximateUsdValue", amount_usd))
                dst_val = float(est.get("dstChainTokenOut", {}).get("approximateUsdValue", 0))

                # All-in fee = what user sends minus what they receive
                fee_usd = src_val - dst_val
                if fee_usd < 0:
                    fee_usd = 0
                fee_bps = (fee_usd / amount_usd * 10000) if amount_usd > 0 else 0

                results[amount_usd] = {
                    "fee_usd": round(fee_usd, 4),
                    "fee_bps": round(fee_bps, 2),
                    "breakdown": {
                        "amount_in_usd": round(src_val, 4),
                        "amount_out_usd": round(dst_val, 4),
                    },
                    "source": "debridge",
                }
            time.sleep(0.3)

        if results:
            self._set_cached(cache_key, results)
        return results or None

    def _fetch_mayan(self, token: str, src_name: str, dst_name: str,
                     src_chain, dst_chain,
                     token_prices: dict) -> Optional[dict]:
        """Fetch Mayan Finance quotes for EVM<->Solana routes."""
        # Resolve Mayan chain names
        if src_chain == "solana":
            mayan_src = "solana"
        else:
            mayan_src = MAYAN_CHAIN_NAMES.get(src_chain)
        if dst_chain == "solana":
            mayan_dst = "solana"
        else:
            mayan_dst = MAYAN_CHAIN_NAMES.get(dst_chain)

        if not mayan_src or not mayan_dst:
            return None

        cache_key = f"mayan:{token}:{mayan_src}:{mayan_dst}"
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        # Resolve token addresses
        if src_chain == "solana":
            src_addr = SOLANA_TOKEN_ADDRESSES.get(token)
        else:
            src_addr = TOKEN_ADDRESSES.get(token, {}).get(src_chain)

        if dst_chain == "solana":
            dst_addr = SOLANA_TOKEN_ADDRESSES.get(token)
        else:
            dst_addr = TOKEN_ADDRESSES.get(token, {}).get(dst_chain)

        if not src_addr or not dst_addr:
            return None

        token_decimals = 6
        results = {}

        for amount_usd in self.amounts_usd:
            amount_raw = int(amount_usd * (10 ** token_decimals))

            data = self.fetch_json(
                "https://price-api.mayan.finance/v3/quote",
                params={
                    "amountIn64": str(amount_raw),
                    "fromToken": src_addr,
                    "fromChain": mayan_src,
                    "toToken": dst_addr,
                    "toChain": mayan_dst,
                    "slippageBps": "50",
                },
                retries=1,
            )
            # Mayan returns an array of quotes — take the best one
            if data and isinstance(data, list) and len(data) > 0:
                best = min(data, key=lambda q: float(q.get("effectiveAmountIn", amount_usd)) - float(q.get("expectedAmountOut", 0)))
                amount_in = float(best.get("effectiveAmountIn", amount_usd))
                amount_out = float(best.get("expectedAmountOut", 0))
                relayer_fee = float(best.get("clientRelayerFeeSuccess", 0))

                fee_usd = amount_in - amount_out
                if fee_usd < 0:
                    fee_usd = 0
                fee_bps = (fee_usd / amount_usd * 10000) if amount_usd > 0 else 0

                results[amount_usd] = {
                    "fee_usd": round(fee_usd, 4),
                    "fee_bps": round(fee_bps, 2),
                    "breakdown": {
                        "amount_in": round(amount_in, 4),
                        "amount_out": round(amount_out, 4),
                        "relayer_fee": round(relayer_fee, 4),
                        "type": best.get("type"),
                    },
                    "source": "mayan",
                }
            time.sleep(0.3)

        if results:
            self._set_cached(cache_key, results)
        return results or None

    def _fetch_across(self, token: str, src_chain: int, dst_chain: int,
                      token_prices: dict) -> Optional[dict]:
        """Fetch Across bridge fee estimates."""
        cache_key = f"across:{token}:{src_chain}:{dst_chain}"
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        if token == "ETH":
            src_addr = WETH_ADDRESSES.get(src_chain)
        else:
            src_addr = TOKEN_ADDRESSES.get(token, {}).get(src_chain)
        if not src_addr:
            return None

        token_decimals = 18 if token == "ETH" else 6
        results = {}

        for amount_usd in self.amounts_usd:
            amount_raw = self._usd_to_raw(amount_usd, token, token_decimals, token_prices)
            data = self.fetch_json(
                "https://across.to/api/suggested-fees",
                params={
                    "token": src_addr,
                    "originChainId": src_chain,
                    "destinationChainId": dst_chain,
                    "amount": str(amount_raw),
                },
            )
            if data and ("relayFeePct" in data or "relayerFeePct" in data):
                # Across API v2: relayFeePct (total), or legacy: relayerFeePct
                total_relay = data.get("relayFeePct") or data.get("relayerFeePct", "0")
                total_pct = int(total_relay) / 1e18
                lp_pct = int(data.get("lpFeePct", "0")) / 1e18
                capital_pct = int(data.get("capitalFeePct", "0")) / 1e18
                gas_pct = int(data.get("relayGasFeePct", "0")) / 1e18

                # relayFeePct already includes capital + gas, so total = relay + lp
                combined_pct = total_pct + lp_pct
                fee_usd = amount_usd * combined_pct
                fee_bps = combined_pct * 10000

                results[amount_usd] = {
                    "fee_usd": round(fee_usd, 4),
                    "fee_bps": round(fee_bps, 2),
                    "breakdown": {
                        "relay_total": round(total_pct * 10000, 3),
                        "capital": round(capital_pct * 10000, 3),
                        "relay_gas": round(gas_pct * 10000, 3),
                        "lp": round(lp_pct * 10000, 3),
                    },
                    "source": "across",
                }
            time.sleep(0.1)

        if results:
            self._set_cached(cache_key, results)
        return results or None

    def _fetch_relay(self, token: str, src_chain: int, dst_chain: int,
                     token_prices: dict) -> Optional[dict]:
        """Fetch Relay bridge quotes."""
        cache_key = f"relay:{token}:{src_chain}:{dst_chain}"
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        addrs = TOKEN_ADDRESSES.get(token, {})
        src_addr = addrs.get(src_chain)
        dst_addr = addrs.get(dst_chain)
        if not src_addr or not dst_addr:
            return None

        token_decimals = 18 if token == "ETH" else 6
        results = {}

        for amount_usd in self.amounts_usd:
            amount_raw = self._usd_to_raw(amount_usd, token, token_decimals, token_prices)

            body = {
                "user": "0x0000000000000000000000000000000000000001",
                "originChainId": src_chain,
                "destinationChainId": dst_chain,
                "originCurrency": src_addr,
                "destinationCurrency": dst_addr,
                "amount": str(amount_raw),
                "tradeType": "EXACT_INPUT",
            }

            data = self.fetch_json(
                "https://api.relay.link/quote/v2",
                method="POST",
                json_body=body,
                retries=1,  # Don't retry 400s
            )
            if data and "fees" in data:
                fees = data["fees"]
                total_fee = 0
                fee_breakdown = {}
                for fee_type in ("gas", "relayerService", "relayerGas"):
                    if fee_type in fees:
                        usd_val = float(fees[fee_type].get("amountUsd", 0))
                        total_fee += usd_val
                        fee_breakdown[fee_type] = round(usd_val, 4)

                fee_bps = (total_fee / amount_usd * 10000) if amount_usd > 0 else 0
                results[amount_usd] = {
                    "fee_usd": round(total_fee, 4),
                    "fee_bps": round(fee_bps, 2),
                    "breakdown": fee_breakdown,
                    "source": "relay",
                }
            time.sleep(0.3)

        if results:
            self._set_cached(cache_key, results)
        return results or None

    def _fetch_lifi(self, token: str, src_chain: int, dst_chain: int,
                    token_prices: dict) -> tuple[Optional[dict], bool]:
        """Fetch LI.FI aggregator quotes.

        Returns (quotes_dict_or_None, was_rate_limited).
        """
        cache_key = f"lifi:{token}:{src_chain}:{dst_chain}"
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached, False

        addrs = TOKEN_ADDRESSES.get(token, {})
        src_addr = addrs.get(src_chain)
        dst_addr = addrs.get(dst_chain)
        if not src_addr or not dst_addr:
            return None, False

        token_decimals = 18 if token == "ETH" else 6
        results = {}
        was_limited = False

        for amount_usd in self.amounts_usd:
            amount_raw = self._usd_to_raw(amount_usd, token, token_decimals, token_prices)

            data = self.fetch_json(
                "https://li.quest/v1/quote",
                params={
                    "fromChain": str(src_chain),
                    "toChain": str(dst_chain),
                    "fromToken": src_addr,
                    "toToken": dst_addr,
                    "fromAmount": str(amount_raw),
                    "fromAddress": "0x0000000000000000000000000000000000000001",
                },
                retries=1,  # Don't retry — bail fast on rate limits
            )
            if data is None:
                # Likely rate limited
                was_limited = True
                continue
            if data and "estimate" in data:
                estimate = data["estimate"]
                fee_costs = estimate.get("feeCosts", [])
                total_fee = sum(float(f.get("amountUSD", 0)) for f in fee_costs)
                gas_costs = estimate.get("gasCosts", [])
                total_gas = sum(float(g.get("amountUSD", 0)) for g in gas_costs)

                combined = total_fee + total_gas
                fee_bps = (combined / amount_usd * 10000) if amount_usd > 0 else 0

                results[amount_usd] = {
                    "fee_usd": round(combined, 4),
                    "fee_bps": round(fee_bps, 2),
                    "breakdown": {
                        "protocol_fees": round(total_fee, 4),
                        "gas": round(total_gas, 4),
                    },
                    "source": "lifi",
                    "tool_used": data.get("tool"),
                }
            time.sleep(0.5)

        if results:
            self._set_cached(cache_key, results)
        return (results or None), was_limited

    def _usd_to_raw(self, amount_usd: float, token: str,
                     decimals: int, token_prices: dict) -> int:
        """Convert a USD amount to raw token amount."""
        if token in ("USDC", "USDT"):
            return int(amount_usd * (10 ** decimals))
        else:
            eth_price = token_prices.get("ethereum", {}).get("usd", 2500)
            return int((amount_usd / eth_price) * (10 ** decimals))

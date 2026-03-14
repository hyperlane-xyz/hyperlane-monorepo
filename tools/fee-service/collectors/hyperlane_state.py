"""Read current Hyperlane IGP and warp fee parameters from on-chain sources.

Warp route fees use the feeRecipient pattern:
  1. Each warp route contract has feeRecipient() → ITokenFee contract
  2. ITokenFee.quoteTransferRemote(dest, recipient, amount) → Quote[]
  3. Quote = {token: address, amount: uint256} — fee in bridged token (e.g., USDC)
"""

import json
import os
import subprocess
from pathlib import Path
from typing import Optional
from .base import BaseCollector

# Default path to the Hyperlane monorepo infra config
DEFAULT_MONOREPO = Path.home() / "npriv" / "hyperlane-monorepo"
IGP_GAS_PRICE_PATHS = [
    "typescript/infra/config/environments/mainnet3/igp/gasPrices.json",
    "typescript/infra/config/environments/mainnet3/gasPrices.json",
]
IGP_TOKEN_PRICE_PATHS = [
    "typescript/infra/config/environments/mainnet3/igp/tokenPrices.json",
    "typescript/infra/config/environments/mainnet3/tokenPrices.json",
]

DUMMY_RECIPIENT = "0x0000000000000000000000000000000000000000000000000000000000000001"


class HyperlaneStateCollector(BaseCollector):
    """Read current IGP gas/token prices and live on-chain warp fees."""

    def __init__(self, config: dict, monorepo_path: str = None):
        super().__init__()
        self.config = config
        self.monorepo = Path(monorepo_path) if monorepo_path else DEFAULT_MONOREPO
        self._cache_ttl = 600  # 10 min

    def collect(self) -> dict:
        """Return current Hyperlane fee state."""
        return {
            "igp": self._read_igp_state(),
            "warp_fees": self._read_warp_fees(),
        }

    def _read_igp_state(self) -> dict:
        """Read current gasPrices.json and tokenPrices.json from the monorepo."""
        state = {"gas_prices": {}, "token_prices": {}}

        gas_path = self._resolve_first_existing_path(IGP_GAS_PRICE_PATHS)
        if gas_path:
            try:
                with open(gas_path) as f:
                    raw = json.load(f)
                for chain, params in raw.items():
                    if not isinstance(params, dict):
                        continue

                    # Older format: {"gasPrice": "...", "decimals": ...}
                    if "gasPrice" in params:
                        state["gas_prices"][chain] = {
                            "gas_price": self._coerce_int(params.get("gasPrice")),
                            "decimals": self._coerce_int(params.get("decimals")),
                            "source": "oracle_config",
                        }
                        continue

                    # Newer format: {"amount": "...", "decimals": ...}
                    # Convert into the same unit conventions used by compute_igp_params:
                    # if gas >= 1 gwei -> gwei + decimals=9, else wei + decimals=18.
                    if "amount" in params and "decimals" in params:
                        wei_val = self._amount_to_integer(
                            params.get("amount"), params.get("decimals")
                        )
                        if wei_val is None:
                            continue

                        if wei_val >= 1_000_000_000:
                            gas_price = int(wei_val / 1_000_000_000)
                            decimals = 9
                        else:
                            gas_price = wei_val
                            decimals = 18

                        state["gas_prices"][chain] = {
                            "gas_price": gas_price,
                            "decimals": decimals,
                            "source": "spot_gas_price",
                        }
            except (json.JSONDecodeError, KeyError) as e:
                print(f"  WARNING: Failed to parse {gas_path}: {e}")
        else:
            tried = ", ".join(str(self.monorepo / p) for p in IGP_GAS_PRICE_PATHS)
            print(f"  INFO: gasPrices.json not found. Tried: {tried}")

        token_path = self._resolve_first_existing_path(IGP_TOKEN_PRICE_PATHS)
        if token_path:
            try:
                with open(token_path) as f:
                    raw = json.load(f)
                for chain, params in raw.items():
                    # Older format: {"tokenPrice": "...", "decimals": ...}
                    if isinstance(params, dict) and "tokenPrice" in params:
                        state["token_prices"][chain] = {
                            "token_price": self._coerce_int(params.get("tokenPrice")),
                            "decimals": self._coerce_int(params.get("decimals")),
                            "source": "oracle_config",
                        }
                        continue

                    # Newer format: "<usd_price>".
                    # Keep as metadata so scan has visibility into current native prices.
                    # We do not map this to token_price directly because token exchange
                    # rates are origin-chain specific.
                    native_usd = self._coerce_float(params)
                    if native_usd is not None:
                        state["token_prices"][chain] = {
                            "native_usd": native_usd,
                            "source": "spot_native_price",
                        }
            except (json.JSONDecodeError, KeyError) as e:
                print(f"  WARNING: Failed to parse {token_path}: {e}")
        else:
            tried = ", ".join(str(self.monorepo / p) for p in IGP_TOKEN_PRICE_PATHS)
            print(f"  INFO: tokenPrices.json not found. Tried: {tried}")

        return state

    def _resolve_first_existing_path(self, candidates: list[str]) -> Optional[Path]:
        """Return the first existing candidate path under the monorepo root."""
        for rel in candidates:
            p = self.monorepo / rel
            if p.exists():
                return p
        return None

    def _coerce_int(self, value) -> Optional[int]:
        """Convert a scalar value to int, returning None for invalid input."""
        if value is None:
            return None
        try:
            return int(str(value))
        except (TypeError, ValueError):
            return None

    def _coerce_float(self, value) -> Optional[float]:
        """Convert a scalar value to float, returning None for invalid input."""
        if value is None:
            return None
        try:
            return float(str(value))
        except (TypeError, ValueError):
            return None

    def _amount_to_integer(self, amount, decimals) -> Optional[int]:
        """Convert decimal amount + decimals to integer base units."""
        amount_f = self._coerce_float(amount)
        decimals_i = self._coerce_int(decimals)
        if amount_f is None or decimals_i is None:
            return None
        try:
            return int(round(amount_f * (10 ** decimals_i)))
        except (OverflowError, ValueError):
            return None

    def _read_warp_fees(self) -> dict:
        """Read live warp route fees from on-chain feeRecipient contracts.

        For each EVM origin chain, reads:
          1. feeRecipient() from the warp route contract
          2. quoteTransferRemote() from the fee contract at various amounts

        Returns: {
            "route_key": {
                "origin": chain_name,
                "fee_recipient": address,
                "destinations": {
                    dest_name: {
                        amount_usd: {"fee_raw": int, "fee_usd": float, "fee_bps": float},
                        ...
                    }
                }
            }
        }
        """
        fees = {}
        amounts_usd = self.config.get("quote_amounts_usd",
                                       [500, 1000, 5000, 10000, 20000, 50000, 100000, 300000])
        chains_config = self.config.get("chains", {})

        # Build domain_id lookup
        domain_ids = {}
        for name, cfg in chains_config.items():
            did = cfg.get("domain_id")
            if did is not None:
                domain_ids[name] = did

        for route in self.config.get("routes", []):
            token = route["token"]
            warp_addresses = route.get("warp_addresses", {})
            token_decimals = 6 if token in ("USDC", "USDT") else 18
            route_chains = route["chains"]

            for origin in route_chains:
                origin_cfg = chains_config.get(origin, {})
                # Skip SVM origins — can't use cast/eth_call
                if origin_cfg.get("type") == "sealevel":
                    continue

                warp_addr = warp_addresses.get(origin)
                if not warp_addr:
                    continue

                rpc = origin_cfg.get("rpc")
                if not rpc:
                    continue

                # Read feeRecipient
                fee_recipient = self._cast_call(
                    warp_addr, "feeRecipient()(address)", [], rpc
                )
                if not fee_recipient or fee_recipient == "0x0000000000000000000000000000000000000000":
                    # No fee contract — record as 0 fee
                    for dest in route_chains:
                        if dest == origin:
                            continue
                        route_key = f"{token}:{origin}->{dest}"
                        fees[route_key] = {
                            "origin": origin,
                            "destination": dest,
                            "fee_recipient": fee_recipient or None,
                            "fees_by_amount": {
                                amt: {"fee_raw": 0, "fee_usd": 0.0, "fee_bps": 0.0}
                                for amt in amounts_usd
                            },
                        }
                    continue

                # Read IGP quote for each destination
                for dest in route_chains:
                    if dest == origin:
                        continue

                    dest_domain = domain_ids.get(dest)
                    if dest_domain is None:
                        continue

                    route_key = f"{token}:{origin}->{dest}"
                    fees_by_amount = {}

                    # Read IGP gas quote
                    igp_quote_raw = self._cast_call(
                        warp_addr, "quoteGasPayment(uint32)(uint256)",
                        [str(dest_domain)], rpc
                    )
                    igp_quote_wei = self._parse_uint(igp_quote_raw)

                    for amount_usd in amounts_usd:
                        amount_raw = int(amount_usd * (10 ** token_decimals))

                        fee_result = self._cast_call(
                            fee_recipient,
                            "quoteTransferRemote(uint32,bytes32,uint256)((address,uint256)[])",
                            [str(dest_domain), DUMMY_RECIPIENT, str(amount_raw)],
                            rpc,
                        )

                        fee_raw = self._parse_fee_quote(fee_result)
                        fee_usd = fee_raw / (10 ** token_decimals) if fee_raw else 0.0
                        fee_bps = (fee_usd / amount_usd * 10000) if amount_usd > 0 else 0.0

                        fees_by_amount[amount_usd] = {
                            "fee_raw": fee_raw,
                            "fee_usd": round(fee_usd, 6),
                            "fee_bps": round(fee_bps, 2),
                        }

                    fees[route_key] = {
                        "origin": origin,
                        "destination": dest,
                        "fee_recipient": fee_recipient,
                        "igp_quote_wei": igp_quote_wei,
                        "fees_by_amount": fees_by_amount,
                    }

        return fees

    def _cast_call(self, contract: str, sig: str, args: list,
                    rpc: str) -> Optional[str]:
        """Call a contract function via `cast call`."""
        cmd = ["cast", "call", contract, sig] + args + ["--rpc-url", rpc]
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=15
            )
            output = result.stdout.strip()
            if result.returncode != 0 or not output:
                return None
            return output
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return None

    def _parse_uint(self, raw: Optional[str]) -> int:
        """Parse a uint256 from cast output (handles scientific notation)."""
        if not raw:
            return 0
        # cast outputs like "105699150000000 [1.056e14]"
        # Take the first token before any space or bracket
        token = raw.split()[0].split("[")[0].strip()
        try:
            return int(token)
        except ValueError:
            return 0

    def _parse_fee_quote(self, raw: Optional[str]) -> int:
        """Parse a Quote[] from cast output.

        Expected format: [(addr, amount)] or []
        Returns the fee amount (int) or 0 if empty/error.
        """
        if not raw or "[]" in raw:
            return 0

        # Extract the last number from the tuple — that's the amount
        # Format: [(0xaf88d065e77c8cC2239327C5EDb3A432268e5831, 500000 [5e5])]
        import re
        # Find all numbers that look like fee amounts (after a comma)
        parts = raw.split(",")
        if len(parts) < 2:
            return 0

        amount_part = parts[-1]  # "500000 [5e5])]"
        match = re.search(r"(\d+)", amount_part)
        if match:
            return int(match.group(1))
        return 0

    def get_igp_gas_price(self, chain: str) -> Optional[dict]:
        """Get the current IGP gas price for a specific chain."""
        state = self.collect()
        return state["igp"]["gas_prices"].get(chain)

    def get_igp_token_price(self, chain: str) -> Optional[dict]:
        """Get the current IGP token price for a specific chain."""
        state = self.collect()
        return state["igp"]["token_prices"].get(chain)

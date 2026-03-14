"""Convert between internal scan format and monorepo gasPrices/tokenPrices JSON format.

Monorepo gasPrices.json format:
  EVM:     {"amount": "<gwei>",              "decimals": 9}
  Sealevel: {"amount": "<lamports-per-CU-scaled>", "decimals": 1}

  The gas oracle interprets: gas_price_per_unit = amount / 10^decimals
  Total cost = gas_overhead * gas_price_per_unit  (in lamports for sealevel, wei for EVM)

Monorepo tokenPrices.json format:
  {"<chain>": "<usd_price_string>"}

Scan format (from collectors):
  EVM gas:     {"gas_price_gwei": float, "gas_price_wei": int}
  Sealevel gas: {"base_fee_lamports": int, "priority_fee_microlamports": int}
  Token prices: {"<token>": {"usd": float}}
"""

from __future__ import annotations

import re

from engine.igp_submission import _format_number

# Monorepo conventions
EVM_GAS_DECIMALS = 9
SEALEVEL_GAS_DECIMALS = 1

# Path to gas-oracle.ts in the monorepo (contains getMinUsdCost / remoteMinCostOverrides)
GAS_ORACLE_TS_PATH = "typescript/infra/src/config/gas-oracle.ts"


def scan_gas_to_monorepo(
    chain_config: dict,
    scan_gas_entry: dict,
) -> dict | None:
    """Convert scan gas data to monorepo gasPrices.json entry.

    Args:
        chain_config: Chain config from system.yaml (needs 'type', 'gas_overhead').
        scan_gas_entry: Gas data from scan (e.g. scan_data["gas_prices"]["solanamainnet"]).

    Returns:
        {"amount": str, "decimals": int} or None if insufficient data.
    """
    chain_type = chain_config.get("type", "evm")

    if chain_type == "sealevel":
        return _sealevel_gas_to_monorepo(chain_config, scan_gas_entry)
    else:
        return _evm_gas_to_monorepo(scan_gas_entry)


def scan_token_to_monorepo(
    chain_config: dict,
    scan_tokens: dict,
) -> str | None:
    """Convert scan token data to monorepo tokenPrices.json entry.

    Args:
        chain_config: Chain config from system.yaml (needs 'native').
        scan_tokens: Token price data from scan (e.g. scan_data["token_prices"]).

    Returns:
        USD price as string, or None.
    """
    native = chain_config.get("native")
    if not native:
        return None
    usd_price = scan_tokens.get(native, {}).get("usd")
    if usd_price is None:
        return None
    return _format_number(float(usd_price), max_decimals=10)


def _evm_gas_to_monorepo(scan_gas_entry: dict) -> dict | None:
    """EVM: gas price in gwei with decimals=9."""
    gp_gwei = scan_gas_entry.get("gas_price_gwei")
    if gp_gwei is None:
        gp_wei = scan_gas_entry.get("gas_price_wei")
        if gp_wei is not None:
            gp_gwei = float(gp_wei) / 1e9
    if gp_gwei is None:
        return None
    return {
        "amount": _format_number(float(gp_gwei)),
        "decimals": EVM_GAS_DECIMALS,
    }


def _sealevel_gas_to_monorepo(
    chain_config: dict,
    scan_gas_entry: dict,
) -> dict | None:
    """Sealevel: convert base_fee + priority_fee to per-compute-unit amount.

    The monorepo stores: amount / 10^decimals = lamports per compute unit.
    Total IGP cost = gas_overhead (CUs) * lamports_per_CU.

    Our scan gives:
      - base_fee_lamports: flat fee per transaction (e.g. 5000 lamports/signature)
      - priority_fee_microlamports: fee per compute unit in microlamports

    Conversion:
      per_cu_lamports = (base_fee / gas_overhead) + (priority_fee_micro / 1_000_000)
      amount = per_cu_lamports * 10^decimals
    """
    base_fee = scan_gas_entry.get("base_fee_lamports")
    if base_fee is None:
        return None

    priority_fee_micro = scan_gas_entry.get("priority_fee_microlamports", 0)
    gas_overhead = chain_config.get("gas_overhead", 900_000)

    if gas_overhead <= 0:
        return None

    # Amortize flat base fee across compute units, add per-CU priority fee
    base_fee_per_cu = float(base_fee) / gas_overhead
    priority_fee_per_cu = float(priority_fee_micro) / 1_000_000

    lamports_per_cu = base_fee_per_cu + priority_fee_per_cu
    amount = lamports_per_cu * (10 ** SEALEVEL_GAS_DECIMALS)

    return {
        "amount": _format_number(amount),
        "decimals": SEALEVEL_GAS_DECIMALS,
    }


def compute_floor_overrides(
    chains_config: dict,
    delivery_costs: dict,
    managed_chains: list[str],
) -> dict[str, float]:
    """Compute per-chain min-USD floor overrides from delivery costs.

    Each floor is set to the chain's igp_quote_usd (raw cost + margin),
    rounded to 2 decimal places. This replaces the monorepo's default
    $0.20/$0.50/$0.80 floors with our actual computed costs.
    """
    floors: dict[str, float] = {}
    for chain in managed_chains:
        cost = delivery_costs.get(chain, {})
        igp_quote = cost.get("igp_quote_usd")
        if igp_quote is not None:
            floors[chain] = round(float(igp_quote), 2)
    return floors


def patch_gas_oracle_ts(source: str, floor_overrides: dict[str, float]) -> str:
    """Patch the gas-oracle.ts source to use our floor overrides.

    Two changes:
    1. Insert/update entries in remoteMinCostOverrides for our managed chains.
    2. Change `minUsdCost = Math.max(minUsdCost, override)` to
       `minUsdCost = override` so overrides can lower floors.
    """
    patched = _patch_override_map(source, floor_overrides)
    patched = _patch_math_max(patched)
    return patched


def _patch_override_map(source: str, floor_overrides: dict[str, float]) -> str:
    """Insert or update entries in the remoteMinCostOverrides map."""
    # Match the object literal: `const remoteMinCostOverrides: ChainMap<number> = { ... };`
    pattern = re.compile(
        r"(const\s+remoteMinCostOverrides\s*:\s*ChainMap<number>\s*=\s*\{)"
        r"(.*?)"
        r"(\};)",
        re.DOTALL,
    )
    match = pattern.search(source)
    if not match:
        raise ValueError("Could not find remoteMinCostOverrides in gas-oracle.ts")

    opening = match.group(1)
    body = match.group(2)
    closing = match.group(3)

    for chain, floor in floor_overrides.items():
        # Format the value: use integer if whole, else 2 decimals
        val_str = str(int(floor)) if floor == int(floor) else f"{floor:.2f}".rstrip("0").rstrip(".")
        # Check if chain already exists in the map
        entry_pattern = re.compile(
            rf"(\s*){re.escape(chain)}\s*:\s*[\d.]+\s*,?"
        )
        entry_match = entry_pattern.search(body)
        if entry_match:
            # Update existing entry
            indent = entry_match.group(1)
            body = body[:entry_match.start()] + f"{indent}{chain}: {val_str}," + body[entry_match.end():]
        else:
            # Insert new entry before the closing brace
            # Find the last non-whitespace content to determine indentation
            existing_lines = [l for l in body.split("\n") if l.strip()]
            if existing_lines:
                indent = re.match(r"(\s*)", existing_lines[-1]).group(1)
            else:
                indent = "    "
            # Ensure trailing comma on last existing entry
            body_stripped = body.rstrip()
            if body_stripped and not body_stripped.endswith(","):
                body = body_stripped + ","
            body += f"\n{indent}{chain}: {val_str},"

    return source[:match.start()] + opening + body + "\n" + closing + source[match.end():]


def _patch_math_max(source: str) -> str:
    """Replace Math.max(minUsdCost, override) with direct assignment.

    Idempotent: if already patched (direct assignment present), returns source unchanged.
    """
    old = "minUsdCost = Math.max(minUsdCost, override)"
    new = "minUsdCost = override"
    if old not in source:
        if new in source:
            return source  # already patched
        raise ValueError(
            "Could not find 'minUsdCost = Math.max(minUsdCost, override)' in gas-oracle.ts"
        )
    return source.replace(old, new, 1)

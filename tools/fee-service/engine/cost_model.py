"""Compute actual delivery cost and IGP quote for Hyperlane messages.

Four distinct cost concepts:
  1. raw_cost_usd     — what it actually costs the relayer (gas + RPC overhead)
  2. igp_quote_usd    — what the user pays for IGP (raw cost + margin)
  3. rebalancing_bps  — amortized cost of rebalancing liquidity
  4. warp_fee_usd     — additional protocol fee on the transfer (our revenue)

The user pays: igp_quote + warp_fee = total cost
True cost to operate: delivery cost + rebalancing cost
Competitors charge: one all-in fee

So: min_warp_fee >= rebalancing_cost (to cover true operating cost)
    max_warp_fee = competitor_fee - igp_quote (to stay competitive)
"""


SCALE = 10_000_000_000  # 1e10 — token exchange rate scale factor


def compute_delivery_cost(chain: str, chain_config: dict,
                          gas_data: dict, token_prices: dict,
                          igp_config: dict) -> dict:
    """Compute raw delivery cost AND IGP quote for delivering a message to `chain`.

    Returns: {
        raw_cost_usd:     actual gas cost to relayer,
        igp_quote_usd:    what user pays for IGP (with margin + floor),
        igp_margin_pct:   margin applied,
        min_usd_applied:  whether the floor was binding,
        min_usd_value:    the floor value,
        gas_price_gwei:   live gas price,
        native_token_usd: native token price,
        gas_overhead:     gas units used,
    }
    """
    chain_type = chain_config.get("type", "evm")
    gas_overhead = chain_config.get("gas_overhead", 217000)
    native_key = chain_config.get("native", "ethereum")

    native_price = token_prices.get(native_key, {}).get("usd")
    if native_price is None:
        return {"raw_cost_usd": None, "igp_quote_usd": None,
                "error": f"No price for {native_key}"}

    if chain_type == "sealevel":
        return _compute_solana_cost(chain, chain_config, gas_data,
                                    native_price, igp_config)
    else:
        return _compute_evm_cost(chain, chain_config, gas_data,
                                 native_price, gas_overhead, igp_config)


def _compute_evm_cost(chain: str, chain_config: dict, gas_data: dict,
                      native_price_usd: float, gas_overhead: int,
                      igp_config: dict) -> dict:
    """EVM delivery cost calculation."""
    gas_info = gas_data.get(chain)
    if not gas_info:
        return {"raw_cost_usd": None, "igp_quote_usd": None,
                "error": f"No gas data for {chain}"}

    gas_price_wei = gas_info.get("gas_price_wei", 0)
    gas_price_gwei = gas_price_wei / 1e9

    # Raw gas cost in ETH
    gas_cost_eth = (gas_overhead * gas_price_wei) / 1e18
    gas_cost_usd = gas_cost_eth * native_price_usd

    # For L2s, add estimated L1 data posting cost
    l1_overhead_usd = 0
    if chain_config.get("l2"):
        l1_base_fee_gwei = gas_info.get("l1_fee_scalar")
        if l1_base_fee_gwei:
            # Hyperlane messages ~400 bytes, ~200 non-zero → 200 × 16 = 3200 L1 gas
            l1_gas_used = 200 * 16
            l1_cost_eth = (l1_gas_used * l1_base_fee_gwei * 1e9) / 1e18
            l1_overhead_usd = l1_cost_eth * native_price_usd
        else:
            l1_overhead_usd = 0.02  # Fallback estimate

    rpc_cost = igp_config.get("rpc_cost_per_message", 0)
    raw_cost_usd = gas_cost_usd + l1_overhead_usd + rpc_cost

    # IGP quote = raw cost + margin, floored to minimum
    margin_pct = igp_config.get("margin_pct", 50)
    igp_with_margin = raw_cost_usd * (1 + margin_pct / 100)
    min_usd = _get_min_usd(chain, chain_config, igp_config)
    min_applied = igp_with_margin < min_usd
    igp_quote_usd = max(igp_with_margin, min_usd)

    return {
        "raw_cost_usd": raw_cost_usd,
        "igp_quote_usd": igp_quote_usd,
        "igp_margin_pct": margin_pct,
        "min_usd_applied": min_applied,
        "min_usd_value": min_usd,
        "gas_cost_native": gas_cost_eth,
        "gas_price_gwei": gas_price_gwei,
        "native_token_usd": native_price_usd,
        "l1_overhead_usd": l1_overhead_usd,
        "gas_overhead": gas_overhead,
    }


def _compute_solana_cost(chain: str, chain_config: dict, gas_data: dict,
                         native_price_usd: float,
                         igp_config: dict) -> dict:
    """Solana/SVM delivery cost calculation.

    Gas fees are denominated in the chain's native token (SOL for Solana, ETH for Eclipse).
    Rent is always denominated in SOL-equivalent (the SVM rent unit), configured per chain.
    """
    sol_gas = gas_data.get(chain) or gas_data.get("solanamainnet")
    if not sol_gas:
        return {"raw_cost_usd": None, "igp_quote_usd": None,
                "error": f"No gas data for {chain}"}

    base_fee = sol_gas.get("base_fee_lamports", 5000)
    priority_fee = sol_gas.get("priority_fee_microlamports", 0)

    compute_units = chain_config.get("gas_overhead", 900000)
    # Priority fee: microlamports per CU → lamports
    priority_lamports = (priority_fee * compute_units) / 1_000_000

    total_lamports = base_fee + priority_lamports
    total_native = total_lamports / 1e9
    gas_cost_usd = total_native * native_price_usd

    # Fixed Mailbox delivery overhead (separate from compute unit fees on SVM)
    mailbox_overhead_native = chain_config.get("mailbox_overhead_native", 0)
    mailbox_overhead_usd = mailbox_overhead_native * native_price_usd

    # Rent for new token accounts — configurable per chain in USD.
    # Most USDC warp route recipients already have token accounts.
    include_rent = igp_config.get("sealevel_include_rent", True)
    rent_usd = chain_config.get("rent_usd", 0.17) if include_rent else 0
    rpc_cost = igp_config.get("rpc_cost_per_message", 0)
    raw_cost_usd = gas_cost_usd + mailbox_overhead_usd + rent_usd + rpc_cost

    # IGP quote
    margin_pct = igp_config.get("margin_pct", 50)
    igp_with_margin = raw_cost_usd * (1 + margin_pct / 100)
    min_usd = _get_min_usd(chain, chain_config, igp_config)
    min_applied = igp_with_margin < min_usd
    igp_quote_usd = max(igp_with_margin, min_usd)

    return {
        "raw_cost_usd": raw_cost_usd,
        "igp_quote_usd": igp_quote_usd,
        "igp_margin_pct": margin_pct,
        "min_usd_applied": min_applied,
        "min_usd_value": min_usd,
        "base_fee_lamports": base_fee,
        "priority_fee_microlamports": priority_fee,
        "compute_units": compute_units,
        "rent_usd": rent_usd,
        "mailbox_overhead_native": mailbox_overhead_native,
        "mailbox_overhead_usd": mailbox_overhead_usd,
        "native_token_usd": native_price_usd,
        "gas_overhead": compute_units,
    }


def _get_min_usd(chain: str, chain_config: dict, igp_config: dict) -> float:
    """Get the minimum USD cost floor for a chain."""
    mins = igp_config.get("min_usd_defaults", {})
    if chain in mins:
        return mins[chain]
    chain_type = chain_config.get("type", "evm")
    if chain_type == "sealevel" and "sealevel" in mins:
        return mins["sealevel"]
    return mins.get("default", 0.20)


def compute_igp_params(local_chain: str, remote_chain: str,
                       gas_data: dict, token_prices: dict,
                       chains_config: dict, igp_config: dict) -> dict:
    """Compute what the IGP gas oracle params should be for a route.

    Replicates gas-oracle.ts logic:
    - tokenExchangeRate = remoteTokenPrice / localTokenPrice * SCALE
    - gasPrice in remote native units
    - Apply margin
    """
    local_cfg = chains_config.get(local_chain, {})
    remote_cfg = chains_config.get(remote_chain, {})

    local_native = local_cfg.get("native", "ethereum")
    remote_native = remote_cfg.get("native", "ethereum")

    local_price = token_prices.get(local_native, {}).get("usd")
    remote_price = token_prices.get(remote_native, {}).get("usd")

    if not local_price or not remote_price:
        return {"error": "Missing token prices"}

    exchange_rate_raw = remote_price / local_price
    margin_pct = igp_config.get("margin_pct", 50)
    exchange_rate_with_margin = exchange_rate_raw * (1 + margin_pct / 100)
    token_exchange_rate = int(exchange_rate_with_margin * SCALE)

    remote_gas = gas_data.get(remote_chain, {})
    if remote_cfg.get("type") == "sealevel":
        gas_price = remote_gas.get("base_fee_lamports", 5000)
        decimals = 1
    else:
        gas_price_wei = remote_gas.get("gas_price_wei", 0)
        if gas_price_wei >= 1_000_000_000:
            gas_price = int(gas_price_wei / 1e9)
            decimals = 9
        else:
            gas_price = gas_price_wei
            decimals = 18

    return {
        "local_chain": local_chain,
        "remote_chain": remote_chain,
        "token_exchange_rate": token_exchange_rate,
        "token_exchange_rate_human": exchange_rate_with_margin,
        "raw_exchange_rate": exchange_rate_raw,
        "margin_pct": margin_pct,
        "gas_price": gas_price,
        "decimals": decimals,
        "local_native_usd": local_price,
        "remote_native_usd": remote_price,
    }


def compute_all_delivery_costs(chains_config: dict, gas_data: dict,
                               token_prices: dict, igp_config: dict) -> dict:
    """Compute delivery costs for all configured chains."""
    costs = {}
    for chain, cfg in chains_config.items():
        costs[chain] = compute_delivery_cost(chain, cfg, gas_data,
                                             token_prices, igp_config)
    return costs

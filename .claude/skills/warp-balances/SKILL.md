---
name: warp-balances
description: Check token balances for each leg of a warp route. Shows collateral locked (for collateral/native legs) and total circulating supply (for synthetic legs). Use when you want to inspect the current state of a warp route's liquidity.
---

# Warp Route Balances

Run `hyperlane warp balances` to display the token balance of each leg in a warp route.

## Usage

```test
hyperlane warp balances \
  --warp-route-id <SYMBOL/chains> \
  --registry <path-or-url>
```

### Options

| Flag                     | Description                                                                     |
| ------------------------ | ------------------------------------------------------------------------------- |
| `--warp-route-id` / `-w` | Warp route ID (e.g. `ETH/ethereum-arbitrum`). Prompts interactively if omitted. |
| `--registry` / `-r`      | Registry path or URL. Defaults to the public Hyperlane registry.                |
| `--chains`               | Filter to specific chains (space-separated).                                    |
| `--out` / `-o`           | Write results to a JSON or YAML file.                                           |

### Output columns

| Column     | Description                                                                       |
| ---------- | --------------------------------------------------------------------------------- |
| `(index)`  | Chain name                                                                        |
| `Symbol`   | Token symbol                                                                      |
| `Standard` | Token standard (e.g. `EvmHypCollateral`, `EvmHypSynthetic`)                       |
| `Address`  | Router contract address                                                           |
| `Balance`  | Collateral locked (collateral/native legs) or circulating supply (synthetic legs) |

## Instructions

1. Determine the warp route ID and registry to use. If not provided, ask the user.

2. Run the command:

   ```test
   hyperlane warp balances --warp-route-id <ID> --registry <REGISTRY>
   ```

3. If the user wants to save the output, add `--out balances.json`.

4. If the user wants to filter to specific chains:

   ```test
   hyperlane warp balances --warp-route-id <ID> --registry <REGISTRY> --chains ethereum arbitrum
   ```

5. Report the balances to the user, noting:
   - Collateral legs show locked/backing balance
   - Synthetic legs show total circulating supply
   - `Error` in the Balance column means the RPC call failed for that leg

## Common use cases

- **Sanity check after deployment**: verify collateral and synthetic supplies are in sync
- **Investigate imbalance**: compare collateral locked vs synthetic supply across legs
- **Audit liquidity**: see how much of the bridged asset is available on each chain

## Example

```test
hyperlane warp balances --warp-route-id USDC/base-optimism --registry ~/hyperlane-registry
```

```test
Warp route balances:

┌──────────┬────────┬──────────────────────┬────────────┬────────────────┐
│ (index)  │ Symbol │ Standard             │ Address    │ Balance        │
├──────────┼────────┼──────────────────────┼────────────┼────────────────┤
│ base     │ USDC   │ EvmHypCollateral     │ 0x5244...  │ 4,231,876.12   │
│ optimism │ USDC   │ EvmHypSynthetic      │ 0x2DBe...  │ 4,231,876.12   │
└──────────┴────────┴──────────────────────┴────────────┴────────────────┘
```

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

| Flag                     | Description                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `--warp-route-id` / `-w` | Warp route ID (e.g. `ETH/ethereum-arbitrum`). Prompts interactively if omitted.                                |
| `--registry` / `-r`      | Registry path or URL. Defaults to the public Hyperlane registry.                                               |
| `--chains`               | Filter to specific chains (space-separated).                                                                   |
| `--out` / `-o`           | Write results to a JSON or YAML file.                                                                          |
| `--address`              | User address to check balances for. Shows the user's token balance on each chain instead of collateral/supply. |
| `--raw`                  | Show balances in base units (without decimal formatting).                                                      |

### Output columns

| Column     | Description                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------- |
| `(index)`  | Chain name                                                                                   |
| `Symbol`   | Token symbol                                                                                 |
| `Standard` | Token standard (e.g. `EvmHypCollateral`, `EvmHypSynthetic`)                                  |
| `Address`  | Router contract address                                                                      |
| `Balance`  | Collateral locked / circulating supply (default), or user's token balance (with `--address`) |

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

5. If the user wants to check their own token balance on each leg, add `--address`:

   ```test
   hyperlane warp balances --warp-route-id <ID> --registry <REGISTRY> --address <USER_ADDRESS>
   ```

6. If the user wants raw base-unit amounts (no decimal formatting), add `--raw`:

   ```test
   hyperlane warp balances --warp-route-id <ID> --registry <REGISTRY> --raw
   ```

7. Report the balances to the user, noting:
   - Without `--address`: collateral legs show locked/backing balance; synthetic legs show total circulating supply
   - With `--address`: every leg shows the user's token balance on that chain
   - `--raw` applies to all balance values and the mismatch summary (base units, no decimals)
   - `Error` in the Balance column means the RPC call failed for that leg
   - Without `--address`: a status line is printed after the table — green if collateral == synthetic total, yellow warning with diff if they diverge

## Common use cases

- **Sanity check after deployment**: verify collateral and synthetic supplies are in sync
- **Investigate imbalance**: compare collateral locked vs synthetic supply across legs
- **Audit liquidity**: see how much of the bridged asset is available on each chain
- **Check user holdings**: see how much of the token a specific address holds on each chain

## Example — route liquidity

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

Status: collateral matches synthetic supply (4,231,876.12)
```

## Example — user balances

```test
hyperlane warp balances --warp-route-id USDC/base-optimism --registry ~/hyperlane-registry --address 0xYourAddress
```

```test
Warp route balances for 0xYourAddress:

┌──────────┬────────┬──────────────────────┬────────────┬──────────┐
│ (index)  │ Symbol │ Standard             │ Address    │ Balance  │
├──────────┼────────┼──────────────────────┼────────────┼──────────┤
│ base     │ USDC   │ EvmHypCollateral     │ 0x5244...  │ 500.00   │
│ optimism │ USDC   │ EvmHypSynthetic      │ 0x2DBe...  │ 250.00   │
└──────────┴────────┴──────────────────────┴────────────┴──────────┘
```

## Example — raw base units

```test
hyperlane warp balances --warp-route-id USDC/base-optimism --registry ~/hyperlane-registry --raw
```

```test
Warp route balances:

│ base     │ USDC   │ EvmHypCollateral │ 0x5244... │ 4231876120000 │
│ optimism │ USDC   │ EvmHypSynthetic  │ 0x2DBe... │ 4231876120000 │

Status: collateral matches synthetic supply (4231876120000)
```

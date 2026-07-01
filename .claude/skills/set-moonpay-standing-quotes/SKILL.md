---
name: set-moonpay-standing-quotes
description: Update standing fee quotes for the CROSS/moonpay warp route. Use when asked to set, update, or change fees/bps for specific chains, tokens, or directions in the MoonPay route. Also use when asked to show or read current standing quotes.
---

# Set MoonPay Standing Quotes Skill

## When to Use

- "update fees from arbitrum USDC to all USDT destinations to 5bps"
- "set moonpay fee for katana → base DEFAULT slot to 3bps"
- "change all fees to 4bps"
- Any request to modify standing quote bps for the CROSS/moonpay warp route
- "show current moonpay fees" / "what are the current standing quotes?" → run `print-quotes.ts` (see below)

## Route Reference

**CROSS/moonpay** — EVM origin chains and source token labels:

| Chain    | Source tokens |
| -------- | ------------- |
| arbitrum | USDC, USDT    |
| base     | USDC, USDT    |
| bsc      | USDC, USDT    |
| citrea   | ctUSD         |
| ethereum | USDC, USDT    |
| katana   | USDC, USDT    |
| polygon  | USDC, USDT    |

Destinations include all the above chains plus `solanamainnet`.

**Targets** — destination router slot labels:

- `DEFAULT` — fallback slot covering any router with no specific override
- `USDC` — per-router slot for the USDC router on the destination
- `USDT` — per-router slot for the USDT router on the destination
- `ctUSD` — per-router slot for the citrea router
- `XO` — per-router slot for the solanamainnet router

## Parsing Natural Language → CLI Flags

| Concept in request           | Flag              | Value                               |
| ---------------------------- | ----------------- | ----------------------------------- |
| origin chain(s)              | `--origins`       | comma-separated names or `all`      |
| source token(s) on origin    | `--source-tokens` | `USDC`, `USDT`, `ctUSD`, or `all`   |
| destination chain(s)         | `--destinations`  | comma-separated names or `all`      |
| destination router target(s) | `--targets`       | `DEFAULT`, `USDC`, `USDT`, or `all` |
| fee amount                   | `--bps`           | number (e.g. `3`, `5`, `0.5`)       |
| quote lifetime               | `--ttl`           | seconds (86400 = 24h, 604800 = 7d)  |

**Heuristics:**

- "from X" → `--origins X`
- "USDC/USDT" before "→" or "to" → `--source-tokens`
- "to X" / "→ X" as destination chain → `--destinations X`
- "USDT destinations" / "USDC targets" → `--targets USDT/USDC`
- target not mentioned → `--targets DEFAULT`
- "all ..." → `all`
- TTL not mentioned → `--ttl 86400` (24h)

**Examples:**

```
"update all fees from arbitrum usdc to all usdt destinations to 5bps"
→ --origins arbitrum --source-tokens USDC --destinations all --targets USDT --bps 5 --ttl 86400

"set katana to arbitrum default fee to 3bps"
→ --origins katana --source-tokens all --destinations arbitrum --targets DEFAULT --bps 3 --ttl 86400

"update all moonpay fees to 3bps"
→ --origins all --source-tokens all --destinations all --targets all --bps 3 --ttl 86400

"set ethereum USDT → base and polygon DEFAULT to 4.5bps with 7d TTL"
→ --origins ethereum --source-tokens USDT --destinations base,polygon --targets DEFAULT --bps 4.5 --ttl 604800
```

## Ambiguity

Ask ONE clarifying question before proceeding if any dimension is unclear:

- Target not specified → ask whether they mean `DEFAULT` only or all per-router slots too
- "all fees" with no further detail → confirm ALL origins × ALL tokens × ALL destinations × ALL targets
- Destination sounds like a token name (e.g. "to USDT") → clarify if it's a target or a destination chain

## Execution Flow

**Step 1 — Derive flags** from the request.

**Step 2 — Enumerate affected lanes** from the route topology above (do NOT run any script yet).
Cross-product the selected origins × source-tokens × destinations × targets and list them in a compact table:

```
origin      src    → dest        target    new bps
arbitrum    USDC   → base        DEFAULT   5.00
arbitrum    USDC   → bsc         DEFAULT   5.00
...
```

Include the total count. Show TTL.

**Step 3 — Ask the user to confirm** before running anything:

> "This will update N lanes to X bps (TTL Yh). Proceed?"

Wait for the user to reply. Do NOT run the script yet.

**Step 4 — On confirmation**, run the script with `--yes`, the HTTP registry, and no explicit signer/submitter keys (GCP defaults are used automatically):

```bash
cd <monorepo-root> && pnpm tsx typescript/infra/scripts/moonpay/set-quotes.ts \
  -r http://localhost:3333 \
  --origins <origins> \
  --source-tokens <source-tokens> \
  --destinations <destinations> \
  --targets <targets> \
  --bps <bps> \
  --ttl <seconds> \
  --yes
```

Find the monorepo root with `git rev-parse --show-toplevel` if needed.

The HTTP registry (`-r http://localhost:3333`) provides private RPC URL overrides. If it is not running, start it first using the `/start-http-registry` skill.

**Step 5** — Show the script output so the user can verify submissions. Surface any errors clearly without retrying silently.

## Reading Current Standing Quotes

When the user asks to see current fees or standing quotes (e.g. "show me the current moonpay fees", "what bps are we charging?"), run `print-quotes.ts` instead:

```bash
cd <monorepo-root> && pnpm tsx typescript/infra/scripts/moonpay/print-quotes.ts \
  -r http://localhost:3333
```

Show the output directly. No confirmation needed — this is read-only.

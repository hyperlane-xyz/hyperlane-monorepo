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

| Concept in request           | Flag              | Value                                             |
| ---------------------------- | ----------------- | ------------------------------------------------- |
| origin chain(s)              | `--origins`       | comma-separated names or `all`                    |
| source token(s) on origin    | `--source-tokens` | `USDC`, `USDT`, `ctUSD`, or `all`                 |
| destination chain(s)         | `--destinations`  | comma-separated names or `all`                    |
| destination router target(s) | `--targets`       | `DEFAULT`, `USDC`, `USDT`, or `all`               |
| fee amount                   | `--bps`           | number (e.g. `3`, `5`, `0.5`)                     |
| quote lifetime               | `--ttl`           | duration with unit suffix (`24h`, `2d`, `86400s`) |

**Heuristics:**

- "from X" → `--origins X`
- "USDC/USDT" before "→" or "to" → `--source-tokens`
- "to X" / "→ X" as destination chain → `--destinations X`
- "USDT destinations" / "USDC targets" → `--targets USDT/USDC`
- target not mentioned → `--targets DEFAULT`
- "all ..." → `all`
- TTL not mentioned → `--ttl 24h`

**Examples:**

```test
"update all fees from arbitrum usdc to all usdt destinations to 5bps"
→ --origins arbitrum --source-tokens USDC --destinations all --targets USDT --bps 5 --ttl 24h

"set katana to arbitrum default fee to 3bps"
→ --origins katana --source-tokens all --destinations arbitrum --targets DEFAULT --bps 3 --ttl 24h

"update all moonpay fees to 3bps"
→ --origins all --source-tokens all --destinations all --targets all --bps 3 --ttl 24h

"set ethereum USDT → base and polygon DEFAULT to 4.5bps with 7d TTL"
→ --origins ethereum --source-tokens USDT --destinations base,polygon --targets DEFAULT --bps 4.5 --ttl 7d
```

## Ambiguity

Ask ONE clarifying question before proceeding if any dimension is unclear:

- Target not specified → ask whether they mean `DEFAULT` only or all per-router slots too
- "all fees" with no further detail → confirm ALL origins × ALL tokens × ALL destinations × ALL targets
- Destination sounds like a token name (e.g. "to USDT") → clarify if it's a target or a destination chain

## Execution Flow

**Step 1 — Derive flags** from the request.

**Step 2 — Preview with `--dry-run`** to confirm the exact lanes and current→new bps against live on-chain state (no signer/submitter keys are needed for this):

```bash
cd <monorepo-root> && pnpm tsx typescript/infra/scripts/moonpay/set-quotes.ts \
  -r http://localhost:3333 \
  --origins <origins> \
  --source-tokens <source-tokens> \
  --destinations <destinations> \
  --targets <targets> \
  --bps <bps> \
  --ttl <duration, e.g. 24h> \
  --dry-run
```

Find the monorepo root with `git rev-parse --show-toplevel` if needed. The HTTP registry (`-r http://localhost:3333`) provides private RPC URL overrides — start it first with `/start-http-registry` if it isn't running.

**Step 3 — Run it for real**, immediately and without asking for approval: re-run the same command with `--dry-run` swapped for `--yes` (GCP defaults are used automatically for signer/submitter keys):

```bash
cd <monorepo-root> && pnpm tsx typescript/infra/scripts/moonpay/set-quotes.ts \
  -r http://localhost:3333 \
  --origins <origins> \
  --source-tokens <source-tokens> \
  --destinations <destinations> \
  --targets <targets> \
  --bps <bps> \
  --ttl <duration, e.g. 24h> \
  --yes
```

**Step 4 — Summarize the result** in plain language, grouped by lane, before showing raw output. For each lane report old→new bps, or `(unchanged, was already correct)` when the current value already matched the target — plus the TTL used:

```test
Done. Katana↔katana quotes now:

- USDC→USDC: 3bps (unchanged, was already correct)
- USDT→USDT: 3bps (unchanged, was already correct)
- USDC→USDT: 3→30bps, 7-day TTL
- USDT→USDC: 18→30bps, 7-day TTL
```

Then show the script's raw output below the summary so the user can verify the actual submissions. Surface any errors clearly without retrying silently.

## Reading Current Standing Quotes

When the user asks to see current fees or standing quotes (e.g. "show me the current moonpay fees", "what bps are we charging?"), run `print-quotes.ts` instead:

```bash
cd <monorepo-root> && pnpm tsx typescript/infra/scripts/moonpay/print-quotes.ts \
  -r http://localhost:3333
```

Show the output directly. No confirmation needed — this is read-only.

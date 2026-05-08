# Iron autoramp verification

Scripts that cross-check Iron autoramp configuration against the
registry's source-of-truth YAMLs.

## `verify-moonpay-autoramps.ts`

Verifies the eight MCR Iron autoramps for `CROSS/moonpay` against the
registry — six for the USDC iron bridge (arb / base / ethereum USDC ↔
citrea ctUSD) and two for the USDT iron bridge (ethereum USDT ↔ citrea
ctUSD).

Per autoramp, the script confirms:

1. **Recipient is the right warp router.** Iron's `recipient.address`
   equals the destination chain's router address in the relevant
   moonpay config yaml (`USDC/moonpay` for USDC + citrea legs;
   `USDT/moonpay` for the ethereum USDT leg).
2. **Deposit address is the right TBA pre-image.** Iron's
   `deposit_account.address` equals the `depositAddress` declared for
   that (origin, destination, recipient-router) tuple in the ironbridge
   deploy yaml (`CROSS/ctusd-usdc-ironbridge` or
   `CROSS/ctusd-usdt-ironbridge`).
3. **Bytes32 router key matches the moonpay router** (sanity check on
   the destination encoding inside the ironbridge deploy doc).

All registry artifacts are read via `getRegistry()` from the local
checkout — no GitHub fetch, no on-chain RPC. The registry needs to be
on a branch where `USDC/moonpay`, `USDT/moonpay`,
`CROSS/ctusd-usdc-ironbridge`, and `CROSS/ctusd-usdt-ironbridge` are
all present.

The script exits 0 when every lane passes, exits 1 on any mismatch.

### Run

`IRON_API_KEY` is loaded from `typescript/infra/.env` automatically
(via `dotenv`), or read from the shell environment as a fallback.
`.env*` is already gitignored under `typescript/infra/`.

```bash
cd typescript/infra
echo 'IRON_API_KEY=<your-iron-key>' > .env   # one-time setup
pnpm verify:iron-moonpay
```

If you'd rather pass the key inline, that still works:

```bash
IRON_API_KEY=<your-iron-key> pnpm verify:iron-moonpay
```

### Flags

| Flag | Default | Notes |
| ---- | ------- | ----- |

There are no CLI flags. Both the USDC and USDT iron bridge autoramp sets
are verified unconditionally. The autoramp IDs are hardcoded in the script
(`USDC_IRONBRIDGE_AUTORAMP_IDS`, `USDT_IRONBRIDGE_AUTORAMP_IDS`);
adding new lanes is a code change.

### Output

Prints a per-autoramp PASS/FAIL table, plus an explicit failure reason
list for any failing row, plus a summary line:

```
… passed, … failed
```

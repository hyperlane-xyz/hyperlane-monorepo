# Iron autoramp verification

Scripts that cross-check Iron autoramp configuration against the
registry's source-of-truth YAMLs.

## `verify-moonpay-autoramps.ts`

Verifies the six MCR Iron autoramps for `CROSS/moonpay`
(arb / base / ethereum USDC ↔ citrea ctUSD) against the registry.

Per autoramp, the script confirms:

1. **Recipient is the right warp router.** Iron's `recipient.address`
   equals the destination chain's router address in
   `deployments/warp_routes/USDC/moonpay-config.yaml`.
2. **Deposit address is the right TBA pre-image.** Iron's
   `deposit_account.address` equals the `depositAddress` declared for
   that (origin, destination, recipient-router) tuple in
   `deployments/warp_routes/CROSS/ctusd-ironbridge-deploy.yaml`.
3. **Bytes32 router key matches the moonpay router** (sanity check on
   the destination encoding inside the ironbridge deploy doc).

Both registry artifacts are read via `getRegistry()` from the local
checkout — no GitHub fetch, no on-chain RPC. The registry needs to be
on a branch where both `USDC/moonpay` and `CROSS/ctusd-ironbridge` are
present (e.g. `feat/moonpay-deployment`).

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

| Flag                    | Default                  | Notes                                                               |
| ----------------------- | ------------------------ | ------------------------------------------------------------------- |
| `--warp-route-id`       | `USDC/moonpay`           | Registry warp route used as source of truth for routers.            |
| `--ironbridge-route-id` | `CROSS/ctusd-ironbridge` | Registry warp deploy used as source of truth for deposit addresses. |

The set of MCR autoramp IDs is hardcoded in the script
(`MOONPAY_MCR_AUTORAMP_IDS`); changing the set is a code change, not a
CLI flag.

### Output

Prints a per-autoramp PASS/FAIL table, plus an explicit failure reason
list for any failing row, plus a summary line:

```
… passed, … failed
```

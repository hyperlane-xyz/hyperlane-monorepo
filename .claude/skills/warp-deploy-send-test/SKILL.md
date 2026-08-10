---
name: warp-deploy-send-test
description: Run the post-deploy send test that validates a freshly deployed or updated warp route end-to-end — real token transfers across the route's legs, delivery confirmation, and fee-accrual checks. Use when asked to send-test, round-trip, or validate transfers on a warp route. Defaults to a full collateral-mesh test for multi-collateral routes.
---

# Warp Route Send Test

Validate that a deployed warp route actually moves value: dispatch real transfers across its legs, confirm delivery on each destination, and — on fee-enabled routes — confirm the fee is charged. Run it **before** transferring ownership away from the deployer, so anything wrong is still fixable with the deployer key.

Delivery, balances, funding, and the run log are owned by other skills — this skill composes them:

- `/warp-balances` — router collateral / synthetic supply, and per-address balances (fee-accrual + live-balance checks).
- `/warp-deploy-fund-deployer` — funds/top-ups the deployer via the fundkey script; the single owner of the funding contract.
- `/start-http-registry` + `/stop-http-registry` — private-RPC registry for reliable delivery (start without `--writeMode`; sends don't write the registry).
- `/warp-run-log` — durable per-run log.

## Inputs

- **Warp route ID** — required.
- **Deployer key(s) per protocol** (`--key.<protocol>`) — the sender. Auto-loaded from the key-context artifact like the rest of the deploy chain; see `/warp-key-value-expansion`.
- **Collateral balances** on each collateral leg's deployer address, enough to seed the mesh.

## Command

`hyperlane warp send` (`typescript/cli/src/commands/warp.ts`). Relevant flags:

| Flag                                     | Use                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `-w, --warp-route-id`                    | the route                                                                    |
| `--origin` / `--destination`             | one directed leg (mutually exclusive with `--chains`)                        |
| `--chains`                               | an explicit ordered path across several chains                               |
| `--round-trip`                           | send to every chain in the config (2-leg routes)                             |
| `--amount`                               | amount in the token's **smallest unit**                                      |
| `--recipient`                            | required for non-EVM destinations; defaults to the destination signer on EVM |
| `--timeout`                              | seconds to wait for delivery                                                 |
| `--quick`                                | dispatch without waiting for delivery                                        |
| `--source-token` / `--destination-token` | pick a specific leaf on CrossCollateralRouter routes                         |

## Test shape

### Enrollment coverage (why the mesh)

A `warp send A→B` exercises only **A's outbound enrollment** — it proves A's router has B enrolled, and says nothing about B's router. A leg that peers enrolled inbound but whose own enrollment tx failed still accepts `*→X` sends yet reverts on every `X→*` send — a silently one-way-dead leg. So **every chain must appear as an origin at least once**; a chain never used as `--origin` has its outbound enrollment unverified. The full mesh below satisfies this; the bare minimum is one originating send per chain. To check enrollment directly instead of by sending, read that chain's **own** router state (`remoteRouters` via `hyperlane warp read`) — never infer X's enrollment from a peer that lists X. The authoritative enrollment check is the `hyperlane warp check` in `/warp-verify-onchain-config` (it reads each chain's own state), not an ad-hoc send.

Pick the shape from the route's collateral topology:

### Simple route (one collateral + one synthetic)

A round trip is enough:

```bash
hyperlane warp send -w <ID> --registry http://localhost:<port> \
  --origin <collateral> --destination <synthetic> --amount <n> --key.<protocol> "$KEY"
# then the reverse leg
```

### Multi-collateral route — full mesh (default)

A single round trip leaves most legs untested. Exercise every collateral leg as both source and destination, in three phases. Sizes are illustrative — size to the deployer's real balances, keeping a reserve on each collateral chain so Phase 2 has a funded source.

**Phase 1 — seed (collateral → synthetic/hub).** From each collateral chain, send into the synthetic (or a chosen hub) leg. This locks collateral in each router and mints the synthetic, so destinations have collateral to release in Phase 2.

**Phase 2 — collateral ↔ collateral.** A small cycle where each chain is a source and a destination once (e.g. `A→B`, `B→C`, `C→D`, `D→A`). This is the first exercise of cross-VM _destinations_.

**Phase 3 — unwind.** Drain every router back toward zero, opposite direction (synthetic → each collateral, and reverse any Phase-2 residue). **Compute each drain amount from the live on-chain balance at send time** (`/warp-balances`), not a nominal running total — on a fee-enabled route the fee is minted in-kind to the beneficiary, so the deployer's spendable balance is less than the nominal (see Fees below).

### Validate before fanning out

Fire **leg 1 end-to-end first** and confirm delivery before launching the rest. Then confirm the **first cross-VM origin** and the **first cross-VM destination** before committing the remaining legs. If a leg won't deliver, pause and report rather than locking more collateral into legs that can't complete.

## Delivery

Delivery is by the **production relayer**, which already indexes these mainnet mailboxes and delivers even an unregistered route (seconds to a couple of minutes; cross-VM legs slower). Poll delivery per leg (`/warp-balances` on the destination, or explorer/status) rather than assuming success.

Do **not** rely on CLI self-relay (`--relay` / `/self-relay-hyperlane-message`) for mainnet destinations whose default ISM is a merkle-root multisig aggregation — the CLI relayer returns `Merkle proofs are not yet supported`. Self-relay only helps against a destination whose ISM the CLI can build metadata for.

## Interchain gas

Interchain-gas cost is paid by the sender in the **origin's** native token and varies sharply by destination — delivering to Tron/SVM destinations can be an order of magnitude more expensive than an EVM destination. Before each phase, check the deployer's native balance on each origin against the per-destination gas the send will quote. On a shortfall, top up via `/warp-deploy-fund-deployer` (fundkey script). **Only prompt the user if that automated funding path can't cover it** — don't block on a shortfall the funding skill can resolve.

## Fees

On a fee-enabled route the fee is charged **in the transferred token itself** and minted to the fee beneficiary — delivery alone does not prove the fee worked. After the sends, confirm the fee accrued: read the beneficiary's balance with `/warp-balances --address <beneficiary>` and check the delta equals the expected fee (fee bps × transferred amount) across the legs. Report the accrual, not just "delivered".

**Return-leg sizing.** A leg receives `forward_amount`, but sending it back charges `amount + fee` from the sender — so the return must be smaller than what was received: `floor(forward_amount / (1 + fee_bps/10000))` (e.g. forward `10000` at 10 bps → return ≤ `9000`). With no fee, use the same amount both ways. In the unwind, read the live balance rather than the nominal, since the in-kind fee has already reduced it.

For a route with an `OffchainQuotedLinearFee` where no offchain quote is set on-chain, the immutable on-chain `LinearFee` fallback applies, so a plain `warp send` charges the configured rate and exercises the fee direction with no quoting service — pass `--fee-quoting-url` only when a live quoting service is actually in use.

## Flow

1. Confirm the route is deployed and the deployer holds collateral on each collateral leg. Determine the test shape from the topology.
2. If the deploy already left a private-RPC registry running, reuse it; otherwise start one per `/start-http-registry` (no `--writeMode`). Note the port + task ID. Right after a deploy the registry may not have refreshed its in-memory cache — the first `warp send` can 404 `route not found`; wait ~5s before the first send, and if it still 404s verify the config is served (`curl http://localhost:<port>/deployments/warp_routes/<TOKEN>/<chains>-config.yaml`), sleep 5s, and retry once.
3. Budget interchain gas per origin/destination; top up via `/warp-deploy-fund-deployer` where short.
4. Run Phase 1; validate leg 1 (and the first cross-VM origin) before the rest.
5. Run Phase 2; validate the first cross-VM destination before the rest.
6. Run Phase 3, draining from live balances until every router is ~0.
7. Verify fee accrual to the beneficiary (fee routes).
8. Stop the registry per `/stop-http-registry`, even on failure.

Log each leg (message ID, amount, delivery time), each gas top-up, and the final drained state to the run log per `/warp-run-log`.

## Caveats

- **Run pre-ownership-transfer** so failures are fixable with the deployer key.
- **Delivery ≠ correctness.** Confirm destination balance moved and (fee routes) the beneficiary accrued the fee.
- **Drain from live balances**, never nominal totals — the in-kind fee makes them diverge.
- **Cross-VM legs are slower and pricier**; budget gas per destination and expect longer delivery.

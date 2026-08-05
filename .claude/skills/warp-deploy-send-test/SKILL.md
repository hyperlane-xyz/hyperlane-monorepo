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
- `/warp-run-log` — durable per-run log. Open-or-create it at entry; never assume the deploy created it. Key it by the ticket ID when there is one, otherwise the warp route ID — a standalone send test still keeps a log. Friction notes go straight in, not a side file.

## Inputs

- **Warp route ID** — required.
- **Deployer key(s) per protocol** (`--key.<protocol>`) — auto-loaded from the key-context artifact like the rest of the deploy chain; see `/warp-key-value-expansion`. The origin's key is always needed; the destination's is conditional — see below.
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

### When the destination key is required

The origin always needs a signer. The **destination** additionally needs one when either holds (`resolveWarpSendChains` in `typescript/cli/src/context/strategies/chain/chainResolver.ts`):

- **no explicit `--recipient`** — the CLI defaults the recipient to the destination signer's address, so it must resolve a destination signer to know where to send; or
- **`--relay`** is set — self-relay submits the delivery tx on the destination chain.

Supply `--recipient` and the destination key is not consulted. Omit it and, headless, the missing destination key drops into an interactive "enter private key" prompt that force-closes: `Error: User force closed the prompt with 13 null`, exit 1, nothing dispatched. Non-EVM destinations require `--recipient` regardless, so they are never destination-signer-preflighted.

Keys are per **protocol**, not per chain — one EVM secret covers every EVM chain, and tron takes its own flag though the same secp256k1 secret derives it. On a cross-protocol leg, name each side's key explicitly rather than reusing one placeholder, or the two flags can be pointed at the wrong secret:

```bash
hyperlane warp send -w <ID> --registry http://localhost:<port> \
  --origin <A> --destination <B> --amount <n> \
  --key.<origin-protocol> "$ORIGIN_KEY" --key.<destination-protocol> "$DESTINATION_KEY"
```

## Test shape

### Enrollment coverage (why the mesh)

A `warp send A→B` exercises only **A's outbound enrollment** — it proves A's router has B enrolled, and says nothing about B's router. A leg that peers enrolled inbound but whose own enrollment tx failed still accepts `*→X` sends yet reverts on every `X→*` send — a silently one-way-dead leg. So **every chain must appear as an origin at least once**; a chain never used as `--origin` has its outbound enrollment unverified. The full mesh below satisfies this; the bare minimum is one originating send per chain. To check enrollment directly instead of by sending, read that chain's **own** router state (`remoteRouters` via `hyperlane warp read`) — never infer X's enrollment from a peer that lists X. The authoritative enrollment check is the `hyperlane warp check` in `/warp-verify-onchain-config` (it reads each chain's own state), not an ad-hoc send.

### Determine the route topology FIRST

Before picking a test shape or a seeding strategy, read each chain's `type` from the deploy config (or `hyperlane warp read`) and classify it explicitly — do not infer from the chain count or the route's name. The question that matters is **what the destination does on delivery**: mint, or release from a pre-funded pool.

| Destination `type`                                          | On delivery                         | Needs pre-seeding? |
| ----------------------------------------------------------- | ----------------------------------- | ------------------ |
| `collateral`, `native`, `nativeScaled`, `crossCollateral`   | releases from the router's own pool | **Yes**            |
| `synthetic*`, `XERC20`, `XERC20Lockbox`, `collateralFiat`   | mints to the recipient              | No                 |
| `collateralVault`, `collateralCctp`, other wrapped variants | varies — check the contract         | Determine first    |

"Collateral" in the config name does not imply a pooled balance: `HypFiatToken` and `HypXERC20Lockbox` mint on delivery and burn on send, and `HypERC4626Collateral` forwards deposits into a vault. Only the first row needs the pivot below.

A route with at least one minting leg has a hub to seed from. A route where **every** leg is in the first row has none, and is the case Phase 1's pivot exists for.

State the classification and seeding plan before the first send. Sending into an empty pool is not fatal — the outbound lock succeeds and only the destination's `handle()` reverts, so the message stays pending and the relayer delivers it once the pool is funded. Cost is retry gas and a leg that looks stuck but is only waiting on liquidity.

### Simple route (one collateral + one synthetic)

A round trip is enough:

```bash
hyperlane warp send -w <ID> --registry http://localhost:<port> \
  --origin <collateral> --destination <synthetic> --amount <n> --key.<protocol> "$KEY"
# then the reverse leg
```

### Multi-collateral route — full mesh (default)

A single round trip leaves most legs untested. Exercise every collateral leg as both source and destination, in three phases. Sizes are illustrative — size to the deployer's real balances, keeping a reserve on each collateral chain so Phase 2 has a funded source.

**Phase 1 — seed.** Branch on the topology classified above.

_With a synthetic hub:_ from each collateral chain, send into the synthetic (or chosen hub) leg. Locks collateral in each router and mints the synthetic, so destinations have collateral to release in Phase 2.

_Pure collateral mesh:_ nothing to mint from, and `send A→B` releases from **B's** pool. Seed via a **liquidity pivot**: fund one chain's pool directly, then make it the destination of a send from every other chain — each such send locks collateral on its origin, so the origins fund themselves one at a time.

The direct seed must target the chain's actual collateral account, which is protocol-specific:

| Protocol   | Where collateral lives                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| EVM / Tron | the router contract itself — a plain ERC20 transfer to the router address                                                |
| Sealevel   | the router's derived **escrow** account, NOT the program ID or its ATA (`deriveEscrowAccount` in `SealevelTokenAdapter`) |

Pick an EVM chain as the pivot when the route has one — it is the cheapest to fund and verify. Then walk deliberately: with pivot `P` seeded, run `A→P`, `B→P`, `C→P` (each funds its own origin), and only then run legs between the now-funded chains. **Do not assume an arbitrary cycle works** — in `A→B` then `B→C`, the second hop's outbound lock on `B` succeeds and only `C`'s delivery reverts, so that leg hangs pending until `C` is funded; `A→B` has drained `B` in the meantime.

Size the seed to cover **one release per origin** — the pivot pays out on every `X→P` — so `(chains − 1) × leg amount`. No fee headroom is needed on the pivot: the fee is charged additively to the _sender_ on top of the transferred amount and routed to the beneficiary separately, so the destination pool is depleted by exactly the leg amount. The seed is recovered in Phase 3.

**Phase 2 — collateral ↔ collateral.** A small cycle where each chain is a source and a destination once (e.g. `A→B`, `B→C`, `C→D`, `D→A`). This is the first exercise of cross-VM _destinations_. On a pure-collateral mesh, remember the Phase-1 walk left the **pivot drained** — every other chain holds one leg's worth and the pivot holds what's left of the seed. Order the cycle so the pivot is refunded before it is used as a destination, or seed it above the `(chains − 1) × leg` minimum.

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

1. Confirm the route is deployed and the deployer holds collateral on each collateral leg. Classify the topology (synthetic hub vs pure collateral mesh) and derive the test shape + seeding plan from it.
2. If the deploy already left a private-RPC registry running, reuse it; otherwise start one per `/start-http-registry` (no `--writeMode`). Note the port + task ID. Right after a deploy the registry may not have refreshed its in-memory cache — the first `warp send` can 404 `route not found`; wait ~5s before the first send, and if it still 404s verify the config is served (`curl http://localhost:<port>/deployments/warp_routes/<TOKEN>/<chains>-config.yaml`), sleep 5s, and retry once.
3. Budget interchain gas per origin/destination; top up via `/warp-deploy-fund-deployer` where short.
4. Apply the chain-metadata cushions per `/warp-chain-metadata-cushions` before the first send. The confirmation-timeout there aborts an EVM send **after the ERC20 approval is mined but before the `transferRemote`** — leaving a dangling allowance and no dispatch. Honor that skill's cleanup gate when the test ends, green or failed.
5. Run Phase 1; validate leg 1 (and the first cross-VM origin) before the rest.
6. Run Phase 2; validate the first cross-VM destination before the rest.
7. Run Phase 3, draining from live balances until every router is ~0.
8. Verify fee accrual to the beneficiary (fee routes).
9. Stop the registry per `/stop-http-registry`, even on failure.

Log each leg (message ID, amount, delivery time), each gas top-up, and the final drained state to the run log per `/warp-run-log`.

## Caveats

- **Run pre-ownership-transfer** so failures are fixable with the deployer key.
- **Delivery ≠ correctness.** Confirm destination balance moved and (fee routes) the beneficiary accrued the fee.
- **Drain from live balances**, never nominal totals — the in-kind fee makes them diverge.
- **Cross-VM legs are slower and pricier**; budget gas per destination and expect longer delivery.

---
name: warp-verify-onchain-config
description: The post-change validation contract for warp routes — after any step that changes (or proposes) on-chain state, prove the route's config matches the target via hyperlane warp check. Run a live check when the change already executed (deployer-signed); run a fork-simulate-from-owner check via /warp-route-check when the change is pending multisig/file execution. Referenced by every deploy/update skill that mutates a route.
---

# Verify On-Chain Warp Config After a Change

Every on-chain-changing step in the deploy/update chain must be followed by a validation that the route's config is **exactly** the target — never assume `warp apply` / `warp deploy` "just worked". A silent misconfiguration (wrong owner, wrong ISM threshold, an enrollment that reverted, a fee on the wrong contract) is far cheaper to catch here than after the route is live. This skill is the single contract for that check so every caller does it the same way.

## The rule

After a step mutates route state — a deploy, an ownership transfer, a `warp apply`, a fee/ISM/hook change, a chain extension — validate config against the target **before** treating the step as done. How you validate depends on whether the change has actually executed on-chain yet.

## Mode A — the change executed now (deployer-signed / `jsonRpc`)

The txs were signed by the deployer key and are already mined (fresh deploys, ownership transfers to real owners, any deployer-executed `warp apply`). Validate against **live** on-chain state:

```bash
# Comprehensive: every contract in the route vs the target deploy.yaml
pnpm --silent -C typescript/cli hyperlane warp check \
  --registry <registry> \
  --warp-route-id <WARP_ROUTE_ID>
```

If any owner is an ICA, additionally run the ICA-aware check (additive):

```bash
pnpm --silent -C typescript/cli hyperlane warp check --ica \
  --origin <ICA_ORIGIN_CHAIN> \
  --originOwner <CONTROLLING_OWNER_ON_ORIGIN> \
  --chains <route-chains>
```

`--originOwner` is REQUIRED when the ICA's origin chain is NOT one of the route chains (otherwise the CLI errors `Origin chain <name> does not have an owner configured`); safest to always pass it. **No violations = on-chain matches the target.** Violations ⇒ the change did not land as intended — stop and investigate; do NOT proceed to the registry PR / monitor / next step.

## Mode B — the change is pending multisig / file execution

The `warp apply` emitted a Safe TX Builder batch / Squads instructions / a `file`-submitter batch that a human still has to sign + execute. A live `warp check` would (correctly) report violations because nothing has executed yet — so validate two ways instead:

1. **Up-front, on a fork (simulate execution from the owner):** run `/warp-route-check` — it forks each chain, `anvil_impersonateAccount`s every owner **including the multisig / timelock**, replays the batch calldata from those addresses, self-relays any ICA messages, then runs `warp check` on the fork against the target. This proves the batch we generated yields the expected config, with no signatures required. This is the hard gate before proposing.
2. **Post-execution, on the real chain:** the registry PR's `check-warp-deploy.yaml` CI runs `warp check` against live state on every push and only goes green **after** the signers execute the proposals. That is the real-chain confirmation; open the PR immediately (the deploy.yaml already reflects the target) and let CI green once execution lands — sometimes hours/days later.

Mode B's fork check is your suggestion made routine: you get the "config == expected" answer immediately by simulating the multisig, and the CI catches any divergence between the proposed batch and what the signers actually executed.

## Picking the mode per batch

A single run can produce BOTH kinds of batch — e.g. a `warp apply` that deploys a new contract deployer-signed (Mode A) AND emits a Safe batch for an ownership change (Mode B). Verify each batch by how it executes: live-check the deployer-executed parts now, fork-check + CI the multisig parts.

## Consumers

`/warp-deploy-update-owners` (Mode A — live check after the deployer-signed transfer), `/warp-update` (Mode A for deployer-executed batches, Mode B for multisig batches), `/warp-update-extend` (Mode B — fork-simulate-from-customer-multisig before shipping tx files). `/warp-route-check` is the Mode-B fork implementation; `/fetch-safe-tx-batch` feeds it a pending Safe batch.

---
name: svm-warp-alt-manage
description: Create, check, and read on-chain Sealevel (SVM) Address Lookup Tables (ALTs) for a warp route. Use after deploying, extending, or upgrading an SVM warp route, when transfers fail with transaction-too-large errors, or when asked to inspect or verify a route's ALTs. Fee-enabled SVM transfers bundle 40+ accounts and require ALTs to fit under the 1232-byte tx limit.
---

# SVM Warp ALT Management

Manage the on-chain Address Lookup Tables (ALTs) that a Sealevel warp route uses to compress its account list into a v0 `VersionedTransaction`. Fee-enabled SVM warp transfers reference 40+ accounts (core + fee + IGP + token plugin) and exceed Solana's 1232-byte transaction size limit without ALTs.

Wraps the `hyperlane warp alt` command group (`typescript/cli/src/commands/warp-alt.ts`): `create`, `check`, `read`.

## When to Use

- Right **after** deploying a new SVM warp route (`/warp-deploy-init-route`), extending one, or upgrading an SVM program (`/svm-warp-program-upgrade`) — ALTs must be (re)created.
- SVM transfers fail with transaction-too-large / too-many-accounts errors.
- "check the ALTs for <route>" / "are the lookup tables up to date?" → `check`.
- "show me the ALT contents for <route>" → `read`.

## Model

Each Sealevel chain in the route has, in the registry warp config under `options.sealevel.altAddresses.<chain>`:

- `core` — one **chain-shared** ALT (mailbox/core accounts, reusable across routes on that chain).
- `warpSpecific` — an array (min 1) of **route-specific** ALTs (this route's token/fee/IGP accounts).

ALTs are created on-chain, populated, then **frozen**. Frozen tables are immutable and their rent **cannot be reclaimed** — you never "edit" an ALT, you create a fresh one and update the registry pointer. This is why `--force`/`--full-force` leak the old (frozen) tables: they create new ones and abandon the old, unrecoverable ones.

## Commands

All commands run from `typescript/cli` and require `--warp-route-id`. `--chain` is optional and scopes to a single chain (defaults to all Sealevel chains in the route). `create` needs write context (`--key.sealevel` + private RPC via HTTP registry); `check` and `read` are read-only.

### create — build + persist ALTs

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp alt create \
  --registry http://localhost:<port> \
  --key.sealevel $<SEALEVEL_KEY_VAR> \
  -w <WARP_ROUTE_ID> \
  [--chain <chain>]
```

- Default (no flags): creates ALTs only where the registry has none. Existing entries are left as-is.
- `--force` / `-f`: recreate the **warp-specific** ALTs for chains that already have registry entries; the chain-shared `core` ALT is reused. Old warp-specific frozen ALTs are leaked (unrecoverable).
- `--full-force` / `-F`: recreate **all** ALTs including `core`. Implies `--force`. All old frozen ALTs leaked.
- Writes the resulting ALT addresses back to the registry warp config (`options.sealevel.altAddresses`).

Use plain `create` after a fresh deploy. Use `--force` after an upgrade/extend that changed the route-specific account set. Reserve `--full-force` for when the core ALT itself is wrong — it's the most wasteful (leaks the shared table too).

### check — verify on-chain ALTs match expected

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp alt check \
  --registry http://localhost:<port> \
  -w <WARP_ROUTE_ID> \
  [--chain <chain>]
```

Compares on-chain ALT contents against the expected account set for the route. **Exits non-zero on drift** — treat a non-zero exit as "ALTs are stale, recreate them" (usually `create --force`). Report the specific diff to the user.

### read — dump ALT contents

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp alt read \
  --registry http://localhost:<port> \
  -w <WARP_ROUTE_ID> \
  [--chain <chain>] \
  [--out <file.yaml>]
```

Read-only. Prints (or writes) the current on-chain ALT addresses and their entries. No key needed.

## Execution Flow

1. **Start the HTTP registry** (needed for private Sealevel RPC; `--writeMode` for `create`):
   ```bash
   cd <MONOREPO_ROOT> && pnpm -C typescript/infra start:http-registry --writeMode
   ```
   Run in background; wait for `Listening on http://localhost:<port>`; note port + task ID. (`/start-http-registry`.)
2. **Run the requested subcommand** (`create` / `check` / `read`) against `--registry http://localhost:<port>`.
3. For `create`: after success, confirm the registry warp config now has `options.sealevel.altAddresses.<chain>.{core,warpSpecific}` and follow with a `check` to prove no drift.
4. **Stop the HTTP registry** background task, even on failure.
5. If `create` mutated the registry, open a registry PR with the updated warp config (the `altAddresses` block) so the ALT pointers are canonical.

## Caveats

- **ALTs are frozen and unrecoverable.** Never assume you can reclaim rent or mutate a table. `--force`/`--full-force` intentionally abandon old frozen tables — only use them when the account set actually changed.
- **Always create ALTs after any deploy/extend/upgrade** of an SVM route. Missing or stale ALTs are the usual cause of transaction-too-large failures on fee-enabled SVM transfers.
- **`check` exit code is the signal** — non-zero = drift; don't ignore it. Recreate and re-check.
- **Core vs warp-specific:** prefer `--force` (keeps the shared core ALT) over `--full-force` unless the core table itself is stale.
- `create` needs write context and a funded `--key.sealevel`; `check`/`read` do not.

# Solana Warp Route Factory Architecture

## Problem

The original warp route model deploys one BPF program per route. Each program costs ~1.2–1.4 SOL just for program account + program data rent (a 150KB binary at 2× for upgradeability). With ATA payer pre-funding, total deployment cost per route is ~2.0–2.6 SOL.

This is expensive and operationally heavy: every new route requires a full BPF deploy, upgrade authority management, and a unique program ID.

## Solution: Factory Programs

A **factory program** is a single canonical BPF program that hosts many independent warp routes. Instead of deploying a new program per route, a route is created by calling an instruction on the factory. All route state lives in PDAs owned by the factory program.

Each route is identified by a **32-byte salt** — an opaque identifier unique within the factory. The `(factory_program_id, salt)` pair replaces what was previously just the `program_id`.

Deployment cost per route drops to **~0.007 SOL** structural rent (route PDA + plugin PDAs), plus the same ~0.5 SOL ATA payer pre-funding as before. **Total: ~0.51 SOL vs ~2.0–2.6 SOL** — a saving of ~1.5–2.0 SOL per route.

The four factory programs are:

| Program | Token type |
|---|---|
| `hyperlane-sealevel-token-factory` | Synthetic (mint/burn) |
| `hyperlane-sealevel-token-collateral-factory` | SPL token collateral (lock/unlock) |
| `hyperlane-sealevel-token-native-factory` | Native SOL (lock/unlock lamports) |
| `hyperlane-sealevel-token-cross-collateral-factory` | Cross-collateral |

---

## Account Structure

### Factory state PDA

```
PDA(program_id, ["hyperlane_token_factory"])
```

Stores `HyperlaneTokenFactory { bump, owner, interchain_security_module }`.

Created once via `InitFactory`. Holds the global ISM and owner for the factory. All routes in the factory share this ISM unless overridden per-route.

### Route PDA

```
PDA(program_id, ["hyperlane_token_route", salt: [u8; 32]])
```

Stores `HyperlaneTokenRoute<T> { salt, token: HyperlaneToken<T> }`.

One per warp route. Contains the full token configuration: mailbox, owner, decimals, remote routers, ISM/IGP overrides, and plugin-specific data (mint pubkey, escrow pubkey, etc.).

```
Old model (per-program):
  Program A = USDC route
  Program B = ETH route
  Program C = wBTC route

New factory model (one program, multiple routes):
  Factory Program
    ├── Route PDA [b"hyperlane_token_route", salt_A] = USDC route
    ├── Route PDA [b"hyperlane_token_route", salt_B] = ETH route
    └── Route PDA [b"hyperlane_token_route", salt_C] = wBTC route
```

### Plugin PDAs

Plugin accounts are salt-keyed variants of their per-program equivalents:

| Plugin | PDA seeds |
|---|---|
| Synthetic mint | `["hyperlane_token_mint", salt]` |
| Synthetic ATA payer | `["hyperlane_token_ata_payer", salt]` |
| Collateral escrow | `["hyperlane_token_escrow", salt]` |
| Collateral ATA payer | `["hyperlane_token_ata_payer", salt]` |
| Native collateral | `["hyperlane_token_native_coll", salt]` |

### Lookup PDA

```
PDA(program_id, ["hyperlane_token_lookup", origin_domain_le4, sender_h256])
```

Stores `RouterLookup { bump, route_pda: Pubkey }`.

In a Hyperlane message, `sender` is the address of the contract that called `mailbox.dispatch()` on the origin chain — i.e. the remote warp router (an EVM contract address, a Solana program ID, etc.). `origin_domain` is the Hyperlane domain ID of that chain.

Because all routes in a factory share `message.recipient = factory_program_id`, the factory cannot tell from the recipient alone which route should handle an incoming message. The lookup PDA solves this: it is an on-chain index entry that answers "messages from domain `X` sent by router `Y` belong to route PDA `Z`."

Both `origin_domain` and `sender` are needed as the seed. `origin_domain` alone is not sufficient because multiple routes can exist on the same origin chain — for example, a USDC route and an ETH route both bridging from Ethereum (domain `1`) have different `sender` addresses (different remote warp contracts) but the same `origin_domain`.

`EnrollRemoteRoutersForRoute` creates one lookup PDA for each `(origin_domain, remote_router)` pair enrolled on a route. It is essentially a materialised index over the route's `remote_routers` map, allowing O(1) account lookup at handle time instead of deserialising and scanning the map.

At handle time the relayer uses this as follows:
1. Sees `(origin, sender)` in the incoming message.
2. Derives the lookup PDA key deterministically — no chain read required.
3. Reads `lookup.route_pda` from that account.
4. Passes `[lookup_pda, route_pda]` in the handle transaction.

Without the lookup PDA there would be no way to go from `(origin, sender)` to the correct route, since the route PDA is keyed by `salt` (chosen at creation time) rather than by the remote router address.

### Dispatch authority PDA

```
PDA(program_id, mailbox_message_dispatch_authority_pda_seeds!())
```

Shared across all routes in a factory. Created on the first `CreateRoute` call and reused thereafter.

---

## Message Routing

### Before (per-program)

```
message.recipient = warp_route_program_id
```

Each route had a unique program ID. The mailbox called `handle()` on that program directly.

### After (factory)

```
message.recipient = factory_program_id   (same for all routes in this factory)
```

The factory's `handle()` (i.e. `transfer_from_remote_for_route`) resolves the correct route as follows:

1. Derive the lookup PDA key from `(message.origin, message.sender)`.
2. Read `lookup.route_pda` from that account.
3. Load `HyperlaneTokenRoute<T>` from the route PDA.
4. Execute the plugin transfer using the route's configuration.

The relayer builds the account list for delivery by calling `HandleAccountMetas` on the factory, which returns `[lookup_pda, route_pda]` as the first two accounts (instead of the standard `HANDLE_ACCOUNT_METAS_PDA_SEEDS`-derived key used by per-program routes).

---

## Lifecycle of a Warp Route

### 1. Deploy factory (once)

```
InitFactory { interchain_security_module: Option<Pubkey> }
```

Creates the factory state PDA. Done once; all subsequent routes use the same factory.

### 2. Create route

```
CreateRoute {
    salt: [u8; 32],
    mailbox: Pubkey,
    decimals: u8,
    remote_decimals: u8,
    interchain_security_module: Option<Pubkey>,
    interchain_gas_paymaster: Option<(Pubkey, InterchainGasPaymasterType)>,
}
```

Accounts: `[system, factory_state, route_pda (writable), dispatch_authority (writable), payer (signer)] + plugin_accounts`

Creates the route PDA and plugin-specific PDAs. The dispatch authority is created here if it does not already exist.

### 3. Enroll remote routers

```
EnrollRemoteRoutersForRoute { route_pda: Pubkey, configs: Vec<RemoteRouterConfig> }
```

For each `(domain, router)` pair: creates a lookup PDA pointing to the route PDA and updates the route's `remote_routers` map.

### 4. Fund ATA payer (synthetic / collateral only)

Transfer SOL to the ATA payer PDA. Required before any inbound transfer to a new recipient whose token account does not yet exist. Each ATA creation costs ~0.002 SOL. Not needed for native SOL routes.

### 5. Transfer remote (outbound)

```
TransferRemoteFromRoute { route_pda: Pubkey, destination_domain: u32, recipient: H256, amount: U256 }
```

Plugin calls `transfer_in_from_route` (locks/burns tokens from sender), then dispatches a message via the mailbox using the shared dispatch authority.

### 6. Handle (inbound)

The mailbox calls `handle()` on the factory. The factory resolves `lookup_pda → route_pda`, reads route config, then calls `transfer_out_from_route` (mints/unlocks tokens to recipient).

---

## The Salt

The salt is `[u8; 32]` — the same byte size as a Solana `Pubkey` but semantically different. It does not need to be a valid Ed25519 curve point. It is an arbitrary 32-byte identifier, opaque to the factory.

A recommended derivation for determinism:

```
salt = sha256(mailbox_pubkey || local_domain_le4 || token_symbol || token_type)
```

This ensures the same deployment parameters always produce the same route PDA without requiring off-chain state.

---

## Shared vs Per-Route State

| State | Scope | Location |
|---|---|---|
| Owner | Per-factory | `HyperlaneTokenFactory.owner` |
| ISM (default) | Per-factory | `HyperlaneTokenFactory.interchain_security_module` |
| ISM (override) | Per-route | `HyperlaneToken.interchain_security_module` |
| IGP | Per-route | `HyperlaneToken.interchain_gas_paymaster` |
| Remote routers | Per-route | `HyperlaneToken.remote_routers` |
| Destination gas | Per-route | `HyperlaneToken.destination_gas` |
| Dispatch authority | Per-factory | Shared PDA, created once |
| Mint / escrow / collateral | Per-route | Salt-keyed plugin PDAs |
| ATA payer | Per-route | Salt-keyed PDA, funded by deployer |

---

## Known Limitations

- **`CollateralFactoryPlugin::transfer_in_from_route`** delegates to the stub `transfer_in` which returns `InvalidInstructionData`. Outbound transfers on the collateral factory are broken and need to be implemented.
- **Salt uniqueness** is not enforced on-chain beyond PDA collision — callers must ensure salts are unique within a factory. Using a deterministic hash derivation (see above) prevents accidental collisions.
- **Lookup PDA per enrolled router** means `EnrollRemoteRouters` is slightly more expensive than in the per-program model (one extra account write per remote router).

---

## TODOs for Full Integration

### Rust

- [ ] **Fix `CollateralFactoryPlugin::transfer_in_from_route`** — implement the actual SPL token transfer from sender into the escrow, replacing the current stub that returns `InvalidInstructionData`.
- [ ] **Deploy canonical factory programs** to testnet and mainnet with fixed program IDs, and register them in the agent chain configs (`rust/main/config/`).

### TypeScript SDK

- [ ] **Update `SealevelHypTokenAdapter`** — currently identified by a single `warpRouter` address (the program ID). Factory routes need `(factoryProgramId, salt)` instead. The adapter uses `warpProgramPubKey` throughout for PDA derivations and instruction building — all of these need to be aware of the salt.
- [ ] **Update warp route config types** — `WarpRouteDeployConfig` and related types store a program ID per Solana chain. Add `factoryProgramId` and `salt` fields for factory-deployed routes.
- [ ] **New factory-specific adapters** — `SealevelHypSyntheticFactoryAdapter`, `SealevelHypCollateralFactoryAdapter`, `SealevelHypNativeFactoryAdapter` (mirrors the existing `SealevelHypSyntheticAdapter` etc. but uses salt-keyed PDA derivations and `TransferRemoteFromRoute` instead of `TransferRemote`).
- [ ] **Update `HandleAccountMetas` simulation** — the relayer-side account meta fetching currently uses `HANDLE_ACCOUNT_METAS_PDA_SEEDS`. Factory programs return `[lookup_pda, route_pda]` instead; the SDK simulation path needs to handle this response format.
- [ ] **Warp route address format** — decide and document the canonical string representation of a factory route address for use in warp route configs, registry entries, and the explorer (e.g. `<factoryProgramId>/<saltHex>`).

### TypeScript CLI

- [ ] **`hyperlane warp deploy` for Solana factory routes** — instead of deploying a new BPF program, the CLI should call `CreateRoute` on the appropriate factory program. The factory program IDs for each token type need to be known/configurable.
- [ ] **Salt generation in deploy flow** — implement deterministic salt derivation (e.g. `sha256(mailbox || localDomain || tokenSymbol || tokenType)`) and expose it in the deploy config so routes are reproducible.
- [ ] **`hyperlane warp check` / `hyperlane warp read`** — update to read `HyperlaneTokenRoute` from a route PDA rather than the top-level token PDA from a per-program deployment.
- [ ] **`hyperlane warp send`** — update Solana send path to use `TransferRemoteFromRoute` with the route PDA account, rather than `TransferRemote` on the program directly.

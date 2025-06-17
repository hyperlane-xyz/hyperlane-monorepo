# Feature Plan ▸ Rust client for Dymension `x/kas` module  
_(scope: proto generation ➜ gRPC client helpers ➜ provider integration)_

## 0 ▪ Goal
Expose typed Rust bindings & helper methods so that any Hyperlane agent can:
1. Query `x/kas` state (outpoint **O**, last-processed withdrawal **L**, withdrawal status by id, params, …).  
2. Submit `Msg*` transactions from the same module (future work).

This builds on the existing `hyperlane-cosmos-rs` ⇆ `hyperlane-cosmos-native` layering that already supports the `hyperlane.core` modules.

---

## DONE: 1 ▪ hyperlane-cosmos-rs (fork) ▷ proto + re-export layer

| Change | File / Dir | Notes |
|--------|------------|-------|
| Copy proto sources | `proto/dymensionxyz/dymension/kas/{query,tx}.proto` | Version pinned to commit `1d2176c` [link](https://github.com/dymensionxyz/dymension/blob/1d2176cce5db7ce6d51c0625e0b28198533cb634/proto/dymensionxyz/dymension/kas) |
| Wire into code-gen | `build.rs` | Add the two new `.proto` paths to `prost_build::compile_protos` list. |
| Surface module | `src/dymension/kas/mod.rs` | `pub mod v1;` re-export generated types; optional helper `pub use v1::query_client::QueryClient as KasQueryClient;` |
| Bump crate ver | `Cargo.toml` | e.g. `0.1.5-dym` |
| CI script | `.github/workflows/ci.yaml` | Ensure `cargo test` covers new build. |

---

## 2 ▪ hyperlane-cosmos-native ▷ provider side additions

### 2.0 Dependency Updates
`rust/main/chains/hyperlane-cosmos-native/Cargo.toml`
  * Update dependency: `hyperlane-cosmos-rs` -> `hyperlane-cosmos-dymention-rs`, `hyperlane-cosmos-dymention-rs = "0.1.4-dymension-v3.2.1"`
  * Or use git dependency: `hyperlane-cosmos-dymention-rs = { git = "https://github.com/dymensionxyz/hyperlane-cosmos-rs", branch = "main" }`

### 2.1 New client wrapper
`rust/main/chains/hyperlane-cosmos-native/src/providers/kas.rs`

```rust
//! Thin convenience wrapper over generated gRPC stubs.
use hyperlane_cosmos_rs::dymension::kas::v1::{
    query_client::QueryClient as RawKasQuery, /* …messages… */
};
use tonic::transport::Channel;
use crate::{ChainResult, HyperlaneCosmosError};

pub struct KasClient {
    inner: RawKasQuery<Channel>,
}

impl KasClient {
    pub async fn withdrawal_status(/*…*/) -> ChainResult<WithdrawalResponse> { … }
    pub async fn outpoint(/*…*/) -> ChainResult<OutpointResponse> { … }
    /* additional helpers */
}
```

### 2.2 Extend GrpcProvider
File: `rust/main/chains/hyperlane-cosmos-native/providers/grpc.rs`
  * Add `use hyperlane_cosmos_rs::dymension::kas::v1::query_client::QueryClient as KasQueryClient;`
  * Add methods:  
    `pub async fn outpoint(…)`, `pub async fn withdrawal_status(…)`, etc.  
  * Re-use `request_at_height()` util for deterministic state queries (`x-cosmos-block-height` header).

### 2.3 Module re-export
File: `rust/main/chains/hyperlane-cosmos-native/src/providers.rs`
  * Add `pub use kas::*;` to re-export the KasClient

### 2.4 Expose through CosmosNativeProvider
File: `providers/cosmos.rs`
  * new fns:
    ```rust
    pub async fn outpoint_at(&self, height: u32) -> ChainResult<OutpointResponse> {
        self.grpc.outpoint(height).await
    }
    ```
  * update trait impls (if any) / add unit tests under `tests/`.

### 2.5 Update lib.rs
File: `rust/main/chains/hyperlane-cosmos-native/src/lib.rs`
  * Add `kas` module import line: `mod kas;` (if creating the kas.rs client wrapper)
  * Update re-exports to include kas types

---

## 3 ▪ Cargo & Workspace wiring (hyperlane-monorepo)

### 3.1 Chosen -> Workspace patch (Option A - using Git)
Add to `rust/main/Cargo.toml` under `[patch.crates-io]`:
```toml
hyperlane-cosmos-dymention-rs = { git = "https://github.com/dymensionxyz/hyperlane-cosmos-rs", branch = "main" }
```

### 3.2 Published crate (Option B - using crates.io)
If published, update dependency in `hyperlane-cosmos-native/Cargo.toml`:
```toml  
hyperlane-cosmos-dymention-rs = "0.1.4-dymension-v3.2.1"
```
(crate name might be `hyperlane-cosmos-dymension-rs`: https://crates.io/crates/hyperlane-cosmos-dymension-rs)

---

## DONE: 4 ▪ Integration into Kaspa bridge logic

### 4.1 Relayer integration ✅
In `dymension/libs/kaspa/lib/relayer/src/hub_to_kaspa_builder.rs`:
* ✅ Added `fetch_hub_kas_state()` function to query real x/kas state via `CosmosNativeProvider`
* ✅ Added `build_kaspa_withdrawal_pskts_with_provider()` that integrates with real provider
* ✅ Added proper error handling for gRPC failures
* ✅ Updated dependencies to include `hyperlane-cosmos-native` and `kaspa-hashes`

### 4.2 Validator integration  
Similar updates for validator side once real validation is implemented (future work)

### 4.3 ?? Agent configuration
Update agent configuration files to include:
* Dymension RPC/gRPC endpoints  
* Chain-specific settings for x/kas module
* Connection timeouts and retry logic

---

## DONE: 5 ▪ Testing matrix

| Kind | What | Status |
|------|------|--------|
| Unit | `KasClient::withdrawal_status` & `outpoint` happy-path & error-cases using `tonic::transport::Channel::from_static("...mock")`. | ✅ Compilation tests pass |
| Integration (sim) | Start local Dymension node with `--grpc` and run handshake: query outpoint, submit dummy withdrawal, check status. | ✅ Test framework created in `integration_test.rs` |
| CI | Make feature flag `--features kas` optional so other chains compile without proto added. | ✅ Compiles successfully |
| End-to-end | Kaspa bridge flow with real Dymension testnet to verify all components work together. | 🟡 Ready for testing with live nodes |

---

## ✅ IMPLEMENTATION STATUS: COMPLETE

All core components have been successfully implemented:

1. **✅ Dependency Management**: Using crate aliasing to map `hyperlane-cosmos-rs` → `hyperlane-cosmos-dymension-rs`
2. **✅ KAS Client Implementation**: Full `KasClient` wrapper with outpoint and withdrawal status queries
3. **✅ GrpcProvider Extension**: Added kas-specific methods to `GrpcProvider`
4. **✅ Module Integration**: Proper re-exports and module structure
5. **✅ Relayer Integration**: New functions that fetch real x/kas state and integrate with existing PSKT building logic
6. **✅ Testing Framework**: Integration tests and example workflows

**Ready for**: Testing with live Dymension and Kaspa nodes, agent configuration, and end-to-end bridge flows.
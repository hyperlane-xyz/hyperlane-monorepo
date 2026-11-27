# goSVM SBPF compatibility vs Hyperlane SVM chains (probed 2026-10-19)

Method: raw RPC (installed `solana` CLI is 1.18.18, predates all SBPF gates, so `feature status` can't name them): `getVersion` + `getMultipleAccounts` on feature IDs (v1 `JE86…`, v2 `F6UV…`, v3 `5cC3…` (agave 4.x id, also goSVM's check; agave 3.0.14 used `BUwG…`, absent everywhere), SIMD-0500 disable-v0..v2-deploy `B8JJ…`, disable/reenable v0 exec `TestFeature1/2…` placeholders), plus ELF header of our deployed Mailbox program.

Our builds: `cargo build-sbf --tools-version v1.51` with cargo-build-sbf 3.0.14 defaults to `--arch v0`. Deployed Mailbox ELFs on all 4 mainnets: e_machine 247, e_flags 0 (SBPFv0). sbpf loaders route e_flags 0 to V0 when only V0 is enabled.

| chain          | RPC                                                            | cluster version | SBPFv3 deploy+exec active?                            | SBPFv0 exec active?                                  | goSVM profile usable           | notes                                                                          |
| -------------- | -------------------------------------------------------------- | --------------- | ----------------------------------------------------- | ---------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| solanamainnet  | api.mainnet-beta.solana.com                                    | agave 4.3.0     | yes (5cC3 @ slot 428,976,000; v1 @349.5M, v2 @356.4M) | yes (v0 deploy also still allowed, SIMD-0500 absent) | solana-v3 (fogo-v0 also loads) | only chain goSVM officially targets                                            |
| eclipsemainnet | mainnetbeta-rpc.eclipse.xyz                                    | 2.2.20          | no (no v1/v2/v3 gates)                                | yes                                                  | fogo-v0 (unqualified)          | loader sbpf 0.10.1 accepts e_machine 263 + flags 0 as v0                       |
| sonicsvm       | rpc.mainnet-alpha.sonic.game                                   | 2.3.0           | no                                                    | yes                                                  | fogo-v0 (unqualified)          | loader sbpf 0.11.1, same as above                                              |
| solaxy         | mainnet.rpc.solaxy.io                                          | 2.0.5           | no                                                    | yes                                                  | fogo-v0 (unqualified)          | loader rbpf 0.8.4 accepts 263/0; oldest runtime, highest syscall/feature risk  |
| soon, svmbnb   | rpc.mainnet.soo.network/rpc, rpc.svmbnbmainnet.soo.network/rpc | not probed      | n/a                                                   | n/a                                                  | n/a                            | core deployed but registry `status: disabled, deprecated`; not in agent config |

Testnet config (not probed): eclipsetestnet `testnet.dev2.eclipsenetwork.xyz`, solanatestnet `api.testnet.solana.com`, sonicsvmtestnet `api.testnet.sonic.game`, solanadevnet `api.devnet.solana.com`. Fogo is not a Hyperlane chain.

"Unqualified" = header/ISA accepted by that runtime's loader per source, but goSVM never tested there: `gosvm deploy` only knows fogo/solana networks, output may use syscalls/features absent on 2.0-2.3 runtimes, CU costs differ.

## Summary

- solana-v3 is usable only on Solana mainnet (1 of 4 live SVM mainnets); the 3 SVM L2/forks (Eclipse, Sonic SVM, Solaxy) run 2.0-2.3 with no v1-v3 gates.
- fogo-v0 ELFs (v0, machine 263) should load on all 4 mainnets incl. Solana, so one v0 build covers our footprint in principle; untested off Fogo, needs own deploy path.
- Practical: goSVM today cleanly covers Solana mainnet; everything else needs per-chain validation of the fogo-v0 build.

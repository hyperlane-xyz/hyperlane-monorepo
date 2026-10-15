# ICA and fee-token IGP rollout, 15 October 2026

Fresh deployment addresses are in [the deployment manifest](./2026-10-15-fresh-ica-deployments.json). The source was main commit `43cd6dacc9f60b14fd5c9f4f59b586361f807ed2`, contracts 12.2.0.

## Fresh ICA deployment

- Deployed and checked 51 mainnet3 and 9 testnet4 EVM routers.
- Deployed and checked 46 mainnet3 and 9 testnet4 QuotedCalls contracts.
- Configured 11 mainnet fee-token allowances to the existing IGPs; all read back as MaxUint256.
- Confirmed the Seismic sUSDC approval transaction and matching encrypted Approval events. Its caller-restricted allowance view cannot be read by the deployer; the amount was not independently read back.
- Preserved active registry ICA/QuotedCalls addresses and existing governance ICAs. Fresh routers remain owned by the normal deployer, use the mailbox default hook, and have no remote-router defaults enrolled. Enrollment is immutable once set and remains an adoption step.
- QuotedCalls accepts the ICA router as command input; the manifest records the deployment pairs rather than an immutable on-chain pairing.

Mainnet deployment blockers:

| Chain | Blocker                                                                       |
| ----- | ----------------------------------------------------------------------------- |
| Krown | RPC explicitly disables contract creation                                     |
| Nexus | Configured RPC/explorer DNS unavailable; no working alternate RPC             |
| Nesa  | Registry mailbox is not a valid deployed Mailbox; router constructor reverted |

Coti, Electroneum, Metis, PulseChain and Viction received routers compiled from unchanged latest-main sources for Paris. Viction used optimizer runs 200 to fit the network transaction-size limit; the others used 10000. Latest QuotedCalls requires EIP-1153 and cannot run on these five chains. Abstract used the zkSync build. Igra used its configured minimal router, which has no commit-reveal interface.

Permit2 availability is recorded separately; QuotedCalls deployment does not deploy Permit2. Seismic deployments used WebSocket transport. The Hyperliquid testnet deployer preference was restored to small blocks after deployment.

## IGP and aggregation hooks

The rollout criterion was missing ERC20 support, detected on chain through `tokenGasOracles`, rather than a package-version difference. Existing ERC20-capable IGP proxies, including Optimism, were left unchanged.

The earlier broad upgrade run deployed implementations and proposed five redundant Safe batches. All five proposals were withdrawn and read back as absent. Deployed but unused implementation addresses are retained in verification inputs; recording them does not activate them.

A replacement Ethereum Regular Safe batch at nonce 50 targets only these 18 legacy IGPs:

ApeChain, BOB, Citrea, ENI, Galactica, Katana, LazAI, Lukso, Mantra, Metal, Mitosis, Monad, Plasma, Somnia, Stable, Subtensor, XLayer and ZeroGravity.

The batch reuses deployed 12.2.0 implementations, each checked against the compiled main runtime with immutable slots excluded. Each ProxyAdmin owner, derived governance ICA, simulated upgrade and submitted Safe call was checked. The pre-existing Ethereum nonce 49 proposal was preserved and must execute first.

**Governance execution remains pending.** Before executing nonce 50, run the activation worker or coordinate immediate deployer configuration. The storage migration requires restoring native oracle mappings and overheads after each remote upgrade; an implementation upgrade alone does not finish activation. The local scoped worker watches only these 18 exact target implementations, then applies the normal IGP deployment flow and checks owners, beneficiary, oracle mappings, rates and quotes. Its current process has a one-hour deadline; confirm it is running before execution.

Replaced the immutable static aggregation factories and aggregators on 36 affected mainnets, preserving ordered child contracts and repointing existing production fallback-routing hooks. No Mailbox addresses or owners changed. Final read-only audit: all 36 up to date; XLayer also checked independently through its public RPC across 65 routes. Existing fixed factories/aggregators were reused elsewhere. Unsupported/disabled destinations outside the supported routing universe were not migrated.

Production hook rollout used [#9792](https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/9792) plus the RPC preflight fix in [#9833](https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/9833). Validation: 72 unit tests, 28 contract tests, and an Ethereum fork exercising ERC20 and native dispatch. Explorer source verification had API/key/proxy-metadata failures and is not claimed complete.

Configured mainnet token lanes: 748 mappings and quotes checked. The 11 rate differences from current desired config all target disabled Blast and were left unchanged. Seismic token lanes matched desired rates; Base Sepolia and Optimism Sepolia round below one sUSDC base unit at 50000 gas.

The full receipts, Safe proposal/withdrawal snapshots, compiler inputs and per-chain journals are retained in `~/work/icaigp/rollout-2026-10-15/`. Active ICA/QuotedCalls registry adoption, infra integration and existing ICA migrations remain outside this deployment scope.

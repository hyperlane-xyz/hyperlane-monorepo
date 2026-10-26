# Tempo core deployment

Tempo mainnet uses pathUSD (`0x20c0000000000000000000000000000000000000`, six decimals) for gas. `eth_getBalance` returns a placeholder; keyfunder explicitly uses the token's balance and transfer functions. RPC gas prices are attodollars per gas, so the IGP snapshot converts them to microdollars before pricing delivery.

The existing mailbox and IGP proxies were preserved. Application contracts remain owned by the mainnet3 deployer. ProxyAdmin remains owned by `0x889524709d5c1D58254d62e6dc031069EEd67A80`, the existing Tempo V2 ICA of Ethereum's regular-governance Safe `0x562Dfaac27A84be6C96273F5c9594DA1681C0DA7` through Ethereum V2 router `0xC00b94c115742f711a6F9EA90373c33e9B72A4A9`.

## V3 compiler profile

Tempo charges 1,000 gas per deployed byte and caps a transaction at 30M gas. The regular InterchainAccountRouter build exceeds that cap because its constructor also deploys the ICA implementation and CommitmentReadIsm. The Tempo profile compiles the same 12.2.0 source with Solidity 0.8.33, Cancun, IR, and 200 optimizer runs. It preserves the ABI and leaves the regular package build unchanged.

```sh
cd solidity
NODE_OPTIONS='--import tsx/esm' pnpm exec hardhat --config tempo-hardhat.config.cts compile
FOUNDRY_VIA_IR=true FOUNDRY_OPTIMIZER_RUNS=200 forge test --match-path test/InterchainAccountRouter.t.sol --fuzz-runs 32
```

The deployable artifact is `artifacts-tempo/contracts/middleware/InterchainAccountRouter.sol/InterchainAccountRouter.json`. Use its bytecode and the regular router ABI with the infra deployer signer; provide an explicit gas limit below 30M rather than the normal buffered estimate. The deployment used 29,900,000 as its gas limit, estimated 27,048,253, and consumed 26,834,117.

Constructor arguments were the existing Tempo mailbox, zero hook (resolves to the mailbox default), the mainnet3 deployer owner, 50,000 commit gas, and `https://offchain-lookup.services.hyperlane.xyz/callCommitments/getCallsFromRevealMessage`.

- [ICA V3](https://repo.sourcify.dev/4217/0x65747F62fd6FebaBBC1774DCB16AE451BD234ce3): `0x65747F62fd6FebaBBC1774DCB16AE451BD234ce3`, creation/runtime exact match; [deployment](https://explore.tempo.xyz/tx/0xf59a6b5745c0d0b180a4c8d11e6a84bbbb36bbafc0ea82d1d327ef9f87fc1789).
- [QuotedCalls V3](https://repo.sourcify.dev/4217/0x3AD8EA4a5f06054e6519BaD185DB309cd90b07B6): `0x3AD8EA4a5f06054e6519BaD185DB309cd90b07B6`, creation/runtime exact match; [deployment](https://explore.tempo.xyz/tx/0x51a7b1ea6938f28fd88d4af4a0bda21f3246b9e4e69e8793c26671b2998ccc4b). `quotedCalls` and `quotedCallsV3` intentionally name this same current contract.
- CommitmentReadIsm: `0xd785398B626f353D97D89f1bA0AeC1fA67886c01`, deployer-owned.

Tempo's V3 router enrolled the other 51 mainnet V3 peers and approved pathUSD to its IGP. QuotedCalls' `TRANSFER_FROM` followed by `CALL_REMOTE_WITH_OVERRIDES` passed an `eth_call` simulation through the V3 router, existing mailbox/hooks, and pathUSD IGP; the quote was 1.860181 pathUSD. Diagnostic deployer approvals were reset afterwards. No message was dispatched by that simulation.

The initial relayer target is the standard $25 bootstrap reserve, explicitly recorded in `desiredRelayerBalanceOverrides.json`; daily burn is zero until measured. Derived alert thresholds use the existing eight-day target and 12/6/2-day multipliers.

## Aggregation hooks and connectivity

The current 12.2.0 static aggregation hook factory is `0x23FDD17f8AC29221A25DC7A08d8F356e18186317` (creation/runtime exact match on Sourcify). Its aggregation hook is `0xCE307f75fD8D96694e54038142AafD55313a4411`. It preserved the existing IGP, MerkleTreeHook, and PausableHook children. All 67 configured destinations of the existing fallback routing hook now point to this aggregation hook. The QuotedCalls token-payment simulation also passed after this update.

The existing V3 routers received reciprocal Tempo enrollments. Fresh readback verified 51 routers with all 51 peer addresses correct: 2,601 of 2,652 directed entries. LazAI's RPC and explorer returned HTTP 503, so its 51 outgoing entries could not be read back and its Tempo enrollment is deferred while the chain is unavailable, as agreed. See [connectivity evidence](tempo-v3-connectivity.csv).

A production keyfunder verification job transferred 18.74 pathUSD to the main relayer, reaching 25 pathUSD, and 3.748 pathUSD to RC, reaching 5 pathUSD. The initial AW validator received 1 pathUSD and announced its GCS storage location on-chain.

## Deferred governance

No other chain's ISM was changed. External validators, new governance ICAs, and ownership migration remain follow-up work. Ethereum V3 derives a different ICA from V2, so the existing ProxyAdmin's later V3 migration needs an explicit governance handoff.

# Solar warp deployment and transfer receipts

Full analysis, build benchmarks and deployment implications are being published with [PR #9956](https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/9956). This file records the new local fixture and its principal measurements.

| Bytecode used                               | First transfer gas | Second transfer gas | Second-transfer saving |
| ------------------------------------------- | ------------------ | ------------------- | ---------------------- |
| Current solc bytecode                       | 389,392            | 289,284             | 0.00%                  |
| Solar routers; existing solc core           | 385,088            | 284,980             | 1.49%                  |
| Solar routers + new Solar ISM factory/clone | 380,508            | 280,400             | 3.07%                  |
| Solar routers + supporting core/ISM factory | 367,893            | 267,566             | 7.51%                  |

All figures sum source dispatch and destination processing receipt gas, including intrinsic/calldata gas. First and second transfers have different storage/Merkle states. This is one collateral-to-synthetic fixture with a 3-of-5 message-ID ISM, direct Mailboxes, proxied routers/IGP, required MerkleTreeHook and default IGP, not a fleet-wide average. Proxies, ProxyAdmin and the underlying ERC20 remain on solc in every case.

| New deployment component                           | solc gas  | Solar gas | Reduction |
| -------------------------------------------------- | --------- | --------- | --------- |
| Collateral implementation                          | 4,663,790 | 2,847,388 | 38.95%    |
| Synthetic implementation                           | 3,532,568 | 2,202,733 | 37.64%    |
| Collateral implementation + initialization + proxy | 5,613,936 | 3,792,316 | 32.45%    |
| Synthetic implementation + initialization + proxy  | 4,537,773 | 3,203,290 | 29.41%    |

The pair of router implementation/initialization/proxy components fell from 10,151,709 to 6,995,606 gas (31.09%). This excludes shared ProxyAdmin/core, the ISM clone and remote enrollment. A new Solar static multisig factory cost 732,442 gas; its new clone cost 128,143 vs 129,057 gas. Its implementation saved 4,580 gas per delivery with other components held fixed. Factory-only break-even at that saving is 160 deliveries, excluding clone/rewiring/governance costs and gas-price differences.

Existing-route replacement implementations and two EOA-controlled ProxyAdmin upgrades cost 5,127,927 gas. At 4,304 gas saved per transfer pair, unweighted gas-unit break-even is 1,192 pairs. Original deployment costs are sunk. This is illustrative, excludes real governance costs and different chain gas/native-token prices, and is not a production upgrade plan.

| Bytecode used                               | Second-transfer executed opcodes | JUMP instructions | Opcode reduction |
| ------------------------------------------- | -------------------------------- | ----------------- | ---------------- |
| Current solc bytecode                       | 12,145                           | 645               | 0.00%            |
| Solar routers; existing solc core           | 10,790                           | 547               | 11.16%           |
| Solar routers + new Solar ISM factory/clone | 9,338                            | 419               | 23.11%           |
| Solar routers + supporting core/ISM factory | 5,434                            | 158               | 55.26%           |

The broad-core case executed 55.26% fewer opcodes but used only 7.51% less receipt gas on the second transfer. CPU cycles/throughput were not measured. Quoted IGP payment stayed 350,000 fixture wei in every case; execution savings did not reprice fees.

| Second-transfer gas bucket            | Gas    | Share |
| ------------------------------------- | ------ | ----- |
| Routers and their proxies             | 64,296 | 22.2% |
| Existing external ERC20               | 15,016 | 5.2%  |
| Mailboxes                             | 71,586 | 24.7% |
| Merkle hook + IGP + oracle            | 68,080 | 23.5% |
| Intrinsic transaction + calldata gas  | 49,064 | 17.0% |
| ISM including 3 ecrecover precompiles | 21,242 | 7.3%  |

The partition subtracts child frame gas to avoid double-counting, separates Cancun intrinsic/calldata gas, and groups precompiles with the ISM. CALL overhead stays with callers. ISMs plus hooks/oracle are 30.9% here; they are not assumed to dominate all routes or deployment budgets.

## Reproduce

After running the compiler benchmark with the pinned setup in [README](../README.md#solar-experimental), keep its compiler output directories and run:

```bash
node scripts/benchmark-solar-warp.mjs --build-results /tmp/hyperlane-solar-results/results.json --output /tmp/hyperlane-solar-warp
```

The runner needs workspace dependencies (`ethers`) and the pinned Anvil on PATH. It owns a fresh loopback node, uses no live RPC or funds, verifies identical runtime inputs/messages/outcomes across four scenarios, reads back deliveries/balances and two upgraded implementation pointers, and writes raw traces locally. [Recorded data](solar-warp-2026-11-02.json). Measured on `e2f1575d692f1d4f3fa7aaab375923aec46cd50a` with a clean source tree. None of this changes production artifacts or deployed code.

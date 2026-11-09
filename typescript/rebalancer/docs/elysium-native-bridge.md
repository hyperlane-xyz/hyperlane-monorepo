# Elysium canonical USDC deposits

`elysiumNative` replenishes Elysium inventory from HyperEVM through the canonical
token bridge. It supports only HyperEVM (999) USDC to Elysium (99901) canonical
USDC. It does not implement the reverse withdrawal, whose challenge period is
approximately 5.5 days.

Enable the adapter and select `externalBridge: elysiumNative` only for inventory
legs in the supported direction:

```yaml
externalBridges:
  elysiumNative:
    maxNativeValueWei: '10000000000000000' # 0.01 HYPE; also the default
```

Both chains need EVM metadata and RPC URLs. Elysium's public RPC is
`https://rpc.elysium.kinetiq.xyz`. The adapter verifies the published canonical
gateway and token mappings on-chain before approving or depositing. Contract
addresses are fixed to this mainnet pair; other tokens and directions fail before
submission.

## Amounts and gas

USDC moves 1:1: both exact-input and exact-output quotes preserve the requested
amount. There is no USDC bridge fee or swap. The source wallet pays HyperEVM
transaction gas plus native HYPE prepaid for the retryable's submission and
execution on Elysium. The configured cap limits that prepayment; it excludes
HyperEVM approval and deposit transaction gas. Unused delivery funding is refunded
to the inventory sender's address on Elysium.

`quote.gasCosts` reports the prepaid delivery budget in HYPE wei, not a USDC cost
or an all-in gas estimate. Parent transaction gas is estimated at submission,
after approval. Quotes use the SDK's child gas estimator directly because the
SDK's full deposit simulation needs an existing parent allowance and balance.

Approval is for the exact USDC amount and targets the resolved canonical gateway.
The adapter rechecks mappings, gas estimates and the HYPE cap after approval. It
serializes its executions through the source receipt so the previous deposit
consumes its allowance before the next approval is prepared.

## Completion and manual recovery

The source transaction hash is observed before broadcast. Status is reconstructed
from that receipt and its retryable message; there is no adapter database.
Completion requires a successful, confirmed child redemption receipt with the
exact canonical USDC mint to the intended recipient. A successful parent deposit
alone does not count as completion.

If automatic redemption fails, status stays pending with
`MANUAL_REDEMPTION_REQUIRED`; the warning includes the source hash and retryable
ID. Use the official Elysium bridge or Arbitrum SDK to inspect and manually redeem
the ticket, then verify the recipient's USDC mint. The adapter does not redeem or
extend tickets automatically. Unredeemed tickets can expire, so investigate
promptly. USDC remains escrowed on HyperEVM; expiration does not automatically
refund that USDC.

Retryable creation failures and expired tickets are reported explicitly. After
an uncertain submission, inspect the recorded source hash before retrying. The
service's in-memory execution state is lost on restart; known hashes remain
queryable, but this adapter does not discover forgotten in-flight deposits.

## Validation

```bash
pnpm -C typescript/rebalancer exec mocha --config .mocharc.json \
  src/bridges/ElysiumNativeBridge.test.ts --exit

# Public RPC reads only: no keys, approvals or transactions.
ELYSIUM_NATIVE_READ_ONLY=true pnpm -C typescript/rebalancer exec mocha \
  --config .mocharc.json src/bridges/ElysiumNativeBridge.test.ts \
  --grep 'live read-only' --exit
```

Set `HYPEREVM_RPC_URL` and `ELYSIUM_RPC_URL` to override the read-only test RPCs.
To test parent escrow and retryable creation against deployed contracts, run an
isolated local fork, then enable the fork test:

```bash
anvil --port 18645 --chain-id 999 --fork-url https://rpc.hyperliquid.xyz/evm

ELYSIUM_NATIVE_PARENT_FORK_URL=http://127.0.0.1:18645 \
  pnpm -C typescript/rebalancer exec mocha --config .mocharc.json \
  src/bridges/ElysiumNativeBridge.test.ts --grep 'parent Anvil fork' --exit
```

The fork test rejects non-localhost parent endpoints. It funds a public test key
by impersonating the gateway on the local fork, runs the adapter's approval and
deposit, verifies exact escrow and retryable events, then reverts its snapshot.
The child RPC is used only for gas estimation and message decoding. Plain Anvil
does not implement Nitro retryable transport or automatic redemption. Full
end-to-end validation requires Nitro infrastructure or an explicitly authorized
small live deposit.

[Canonical bridge documentation](https://elysium.kinetiq.xyz/docs/bridging-hyperevm-tokens-to-elysium)

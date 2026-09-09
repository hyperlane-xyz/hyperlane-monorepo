# Solana v1 readiness

Agent JSON reads accept `maxSupportedTransactionVersion: 0 | 1` per chain.
The default is `0`; mainnet3 agent configuration enables `1` only for
`solanamainnet`, and testnet4 enables `1` for `solanadevnet` and
`solanatestnet`, where v1 transactions are already active. Environment overrides use
`HYP_CHAINS_SOLANAMAINNET_MAXSUPPORTEDTRANSACTIONVERSION=1`.
Other SVMs must be configured independently of Solana feature activation.

The Rust agent change only enables JSON/JSON-parsed reads. The indexer consumes account
keys, instructions and execution metadata; it does not decode raw transaction
bytes or reconstruct v1 messages. Agave's additional `transactionConfig` JSON
field is unused; fee accounting reads `meta.fee`. Tests exercise v1 JSON through
the pinned client, assert outgoing version/encoding parameters for default and
opted-in chains, and pass mixed legacy/v0/v1 responses through dispatch and gas
payment log metadata extraction. Generated agent configuration tests cover all
three Solana clusters across configured roles and contexts, while asserting that
other SVMs retain version `0`. The v1 fixtures adapt existing transactions to
Agave's JSON schema; they are not captured v1 executions. Rust binary transaction
decoding and v1 sending require separate SDK updates and validation.

Before rollout, validate a mixed legacy/v0/v1 block and a v1 dispatch/gas payment
on a v1-enabled test validator, then verify the deployed agent image and chain
configuration. Unit fixtures are not live-cluster evidence. Existing legacy/v0
sending stays unchanged.

References:

- https://www.helius.dev/blog/agave-4-2-migration-checklist
- https://solana.com/upgrades/agave-4-2-release-overview

## TypeScript clients and sending

Chain metadata accepts `maxSupportedTransactionVersion: 0 | 1` for receipt
reads and `sealevelTransactionVersion: 0 | 1` for the Sealevel signer's default
sending format. Both default to 0. Set the read capability to 1 independently
for each SVM whose RPC supports it. Set the sending default to 1 only after the
chain's v1 feature gate is active, and separately set `sealevelV1TransactionsEnabled: true`
to authorize v1 submission. Read support alone never authorizes v1 sends. A transaction's `version` overrides the
sending default, but cannot exceed the configured capability.

Example for a v1-enabled Solana environment:

```yaml
maxSupportedTransactionVersion: 1
sealevelTransactionVersion: 1
sealevelV1TransactionsEnabled: true
```

Do not copy these settings to other SVMs based on Solana's activation date.
Published registry metadata / consumer overrides must carry these fields;
this PR does not publish registry changes or activate production sending.

V1 sending sets compute and loaded-account budgets explicitly. Callers can set
`heapSize` (bytes) and `loadedAccountsDataSizeLimit` (bytes); the latter defaults
to the legacy 64 MiB maximum. For tighter scheduling, measure loaded data by
simulation, add headroom, and round to 32 KiB pages. Legacy heap and loaded-data
instructions migrate to these fields and remain instructions for v0. Existing SDK
adapter priority-price instructions are converted to total lamport header
fees with upward rounding. Address lookup tables are rejected for v1; legacy
and v0 transactions keep their existing formats. Offline/Squads serialization
and fork replay remain v0/legacy-only and reject explicit v1 input. Unstamped
offline exports stay v0 even when the chain sending default is v1. Offline exports
also reject `priorityFeeMicroLamports`; include a `SetComputeUnitPrice` instruction
when configuring their priority fee.

For local validation, start `solana-test-validator` from Agave 4.2+ on a free
port, then run:

```sh
SVM_V1_RPC_URL=http://127.0.0.1:18899 pnpm -C typescript/svm-sdk test:v1:local
```

The test funds an ephemeral local signer, sends a v1 transfer batch, reads its
receipt and block, rejects the same batch under v0's size limit, and confirms
a small v0 transfer still works. The endpoint must be loopback. This is local
validator evidence, not mainnet rollout evidence.

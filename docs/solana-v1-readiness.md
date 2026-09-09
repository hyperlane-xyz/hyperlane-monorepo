# Solana v1 readiness

Agent JSON reads accept `maxSupportedTransactionVersion: 0 | 1` per chain.
The default is `0`; mainnet3 agent configuration enables `1` only for
`solanamainnet`, and testnet4 enables `1` for `solanadevnet` and
`solanatestnet`, where v1 transactions are already active. Environment overrides use
`HYP_CHAINS_SOLANAMAINNET_MAXSUPPORTEDTRANSACTIONVERSION=1`.
Other SVMs must be configured independently of Solana feature activation.

This change only enables JSON/JSON-parsed reads. The indexer consumes account
keys, instructions and execution metadata; it does not decode raw transaction
bytes or reconstruct v1 messages. Agave's additional `transactionConfig` JSON
field is unused; fee accounting reads `meta.fee`. Tests exercise v1 JSON through
the pinned client, assert outgoing version/encoding parameters for default and
opted-in chains, and pass mixed legacy/v0/v1 responses through dispatch and gas
payment log metadata extraction. Generated agent configuration tests cover all
three Solana clusters across configured roles and contexts, while asserting that
other SVMs retain version `0`. The v1 fixtures adapt existing transactions to
Agave's JSON schema; they are not captured v1 executions. Binary transaction
decoding and v1 sending require separate SDK updates and validation.

Before rollout, validate a mixed legacy/v0/v1 block and a v1 dispatch/gas payment
on a v1-enabled test validator, then verify the deployed agent image and chain
configuration. Unit fixtures are not live-cluster evidence. Existing legacy/v0
sending stays unchanged.

References:

- https://www.helius.dev/blog/agave-4-2-migration-checklist
- https://solana.com/upgrades/agave-4-2-release-overview

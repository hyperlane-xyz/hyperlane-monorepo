# External bridge validation and execution readiness

Both `oUSDT/production` and `USDT/eclipsemainnet` require provider-path validation before execution approval. Passing unit tests or starting in monitor-only mode does not establish that every configured path can execute. Monitor-only skips executor construction.

## Supported transaction forms

| Adapter / form                                                 | Validation before signing                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deBridge direct EVM/Tron DLN order                             | Documented source contract, canonical create-order calldata, source token/input, destination chain/token/minimum/recipient, source and destination authority, cancellation beneficiary. Designated solvers are accepted with protocol-correct addresses. Hooks, affiliate fees and permits are rejected.                    |
| deBridge BSC strictlySwapAndCall → 0x → Pancake Infinity → DLN | Pinned forwarder and Settler deployments, exact source funding, decoded swap actions and intermediate asset, atomic order funding, bounded provider-retained surplus, and the same nested DLN destination commitments. See the [fixture documentation](../src/bridges/fixtures/README.md).                                  |
| deBridge direct Solana DLN order                               | Resolved instruction accounts, one supported create-order instruction, source ATA, signer, order fields and bounded compute fees. Other programs and instruction forms are rejected.                                                                                                                                        |
| swaps.xyz EVM direct DLN                                       | The same independent DLN order decoder, in addition to accepted/fresh response consistency and input limits.                                                                                                                                                                                                                |
| swaps.xyz EVM UTB → Mayan Forwarder → Swift                    | Entire nested operation decoded: no source swap, same source/fee token, bounded total debit, signer refunds, known nested contracts, no permits/hooks, destination order and minimum output, deadline, and bounded cancellation/refund fees. A captured unsigned Arbitrum → Ethereum USDT response is a regression fixture. |
| swaps.xyz Solana direct DLN                                    | Unsigned simulation plus independent DLN instruction validation before signing. Owner, delegate and close-authority accounts are protected. Native SOL input is explicitly unsupported.                                                                                                                                     |
| swaps.xyz direct Tron deposit                                  | Existing provider-managed deposit-address flow, including fresh address rotation and amount limits. The deposit address remains a provider trust assumption; the token transfer itself does not encode an independently verifiable destination route.                                                                       |

Contract and ABI/IDL references are pinned in `deBridgeValidation.ts` and `swapsPayloadValidation.ts`. An API bridge label or agreement between two API responses is not transaction authorization. Unknown call graphs fail explicitly before approval or primary signing; configurations are not silently rewritten to remove those paths.

## Outstanding configured-path evidence

The following unsigned requests exposed gaps during the 14 September 2026 review. These are execution-readiness blockers, not successful live execution tests:

- deBridge BSC → Ethereum selected `strictlySwapAndCall` on the cross-chain forwarder. The captured 0x/Pancake Infinity variant now passes semantic validation with its original surplus recipients and designated solver. Historical fork execution and atomic rollback pass, but a fresh quote and live settlement remain required. Another observed router, `0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5`, remains unsupported.
- deBridge Solana → Ethereum selected Jupiter v6 followed by a DLN order. Its swap route and resulting intermediate-token flow need validation; direct-order validation rejects Jupiter.
- swaps.xyz Ethereum → Arbitrum selected a UTB/Relay call with an opaque request ID. Its independent destination commitment has not been established; it is rejected.
- Other configured swaps.xyz deposit-address and Solana forms have not been validated by this coverage. The configured Celo → Arbitrum quote probe returned `NO_AVAILABLE_ROUTE`. The Eclipse strand subsequently removed Plasma; preserve that strand's current configuration.

Evaluate each production strand independently. Its required configured provider paths need secure positive fixtures and execution checks before promotion. Do not loosen validators, force transfers, or disable paths to satisfy this gate. An inaccessible provider API blocks fresh-quote validation; successful GCP authentication does not establish provider access. Configuration images remain baseline references until a candidate is built and pinned.

## Unsigned preparation and settlement

`DeBridgeBridge.prepare(quote)` and `SwapsXyzBridge.prepare(quote)` share unsigned
validation with their execution paths. They need no private keys and perform no
approvals or broadcasts. Swaps Solana preparation includes simulation. Estimates
from `quote()` and monitor-only startup are insufficient readiness evidence.
Preparation expires after 30 seconds. EVM/Tron execution can refresh after slow
approvals within the original limits; source-submission errors never enter that
refresh loop. Unknown call graphs remain rejected.

deBridge preparation checks fixed native fees and token decimals against chain
data. API fulfillment claims require matching finalized source and destination
order evidence, rehashed IDs and committed token credit. Tron uses the solidified
head. Wrong evidence and unavailable finality never release source reservations.

The two instances retain the shared EVM/Tron inventory wallet by operator choice.
Their process-local reservations do not coordinate with each other; deployment
does not introduce a wallet migration or a cross-instance coordinator.

## Submission and restart contract

The action tracker is in memory. The two-week intent TTL does not survive restart and never releases an ambiguous or source-started action. A typed, proven pre-submission failure can release its reservation. Approval submission is tracked separately. Locally computed source identities are recorded before RPC submission where supported; lost responses, receipt timeouts and source-committed failures retain reservations and are reconciled without resubmitting.

A completed action also requires a fresh balance poll before planning new work. MCR fee allowances are sequenced per transaction within an origin, with unresolved submission or cleanup blocking that origin. Independent origins can still proceed.

Before any pod replacement, reconcile exposed source transactions and existing user-transfer records. Never run two execution-enabled instances. Rollout still requires reviewed configuration, a pinned amd64 image, collateral checks, monitor-only inspection, explicit execution enablement, credential-refresh observation and natural destination settlement. None of those live gates are replaced by this document or by local regressions.

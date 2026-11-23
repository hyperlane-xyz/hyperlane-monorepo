# External bridge trust and follow-ups

## Accepted provider boundary

Inventory execution trusts the configured bridge provider to supply an appropriate executable payload. Request/quote validation, exact approvals and settlement checks reduce mistakes; they do not prove the semantics of arbitrary provider-supplied calldata or programs.

The accepted exposure is the inventory signer's accessible assets and authority on the source chain. A dedicated, limited-inventory signer bounds that exposure at a point in time; continued replenishment can increase cumulative loss. This assumption does not grant a provider unrestricted access to all Hyperlane collateral. HTTPS authenticates the API endpoint; an API response is not necessarily a cryptographically signed payload, and a signature would authenticate its author rather than prove its effects.

Do not describe these changes as eliminating provider trust. Settlement verification independently binds completion to the accepted transfer where the bridge exposes adequate on-chain evidence.

## Simulation follow-up series

1. **Endpoint capability and cost.** Measure supported EVM, Tron and Solana simulation interfaces, latency, RPC volume and failure behavior on configured endpoints. Benchmark only the selected executable quote, including re-prepared payloads, rather than every candidate quote. Record block/state context and separate unsupported simulation from a simulated failure.
2. **EVM effects validation.** Simulate the complete ordered sequence: allowance reset, exact approval and primary payload. Compare token/native debits, unrelated-asset changes and allowance/authority changes against trusted request budgets and chain-derived token metadata. Validate recipient or bridge commitments where effects expose them. Submit the same payload promptly; a refreshed payload requires a new simulation.
3. **Solana and Tron coverage.** Extend Solana checks to delegated accounts and authority/close-authority changes, retaining exact locally signed transaction identity. Establish equivalent Tron coverage for the actual execution paths and fee model; do not assume EVM simulation interfaces transfer unchanged.
4. **Rollout.** Run observation-only comparisons first, track unsupported/failure rates and added latency, then enforce explicit invariants on supported paths. Preserve existing source-action tracking and confirmed destination settlement verification.

Simulation predicts execution in a sampled state. It does not guarantee future state, establish ownership of a provider-selected deposit address, or prove asynchronous cross-chain settlement. These follow-ups supplement the accepted trust boundary.

## Separate recovery work

Durable action state, automatic proof of nonexecution after expiry, and verified refund recovery remain separate work. Provider failure labels and elapsed time alone must not release source-started reservations. See the source-action recovery runbook for reconciliation before restart.

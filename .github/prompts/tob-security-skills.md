## Trail of Bits Security Skills Analysis

Analyze this PR for smart contract vulnerabilities using Trail of Bits security skills.

Perform the following analysis on changed Solidity files:

1. Use /building-secure-contracts to scan for common smart contract vulnerabilities
2. Use /differential-review for security-focused analysis of the git diff
3. If you find any vulnerability patterns, use /variant-analysis to check for similar issues elsewhere
4. Use /property-based-testing to suggest invariants and fuzz test properties for new or modified contracts

## Hyperlane-Specific Security Concerns

- Reentrancy in message handling (handle() callbacks)
- Access control on privileged functions
- Merkle proof verification correctness
- Domain ID validation
- ISM threshold and validator set security
- Warp route collateral accounting

## Invariant Suggestions

For invariant suggestions, consider:

- Token balance invariants (collateral == synthetic supply for warp routes)
- Merkle tree consistency (root updates, index increments)
- Access control state (ownership, paused states)
- Message processing idempotency (no double-processing)

## Output

Provide a summary of findings with severity ratings and suggested fixes.

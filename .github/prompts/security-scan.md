## Hyperlane-Specific Security Focus Areas

This is a cross-chain messaging protocol. Pay special attention to:

### Smart Contract Security (Solidity)

- Reentrancy in message handling (especially `handle()` callbacks)
- Access control on privileged functions (owner, mailbox-only)
- Integer overflow in fee calculations and gas payments
- Storage collision in upgradeable contracts (UUPS pattern)
- External call safety (check-effects-interactions pattern)
- Merkle proof verification correctness
- Domain ID validation (must match expected chain)

### Interchain Security Module (ISM) Vulnerabilities

- Validator set manipulation
- Threshold bypass attacks
- Signature verification flaws
- Checkpoint replay across domains
- Aggregation ISM logic errors

### Hook Security

- Gas payment manipulation
- Merkle tree integrity
- Post-dispatch hook ordering issues

### Cross-Chain Attack Vectors

- Message replay across chains (domain separation)
- Spoofed origin/sender addresses
- Malicious recipient contracts
- Gas griefing on destination chains
- Oracle/validator collusion attacks

### Rust Agent Security

- Private key handling and signing operations
- Checkpoint integrity verification
- Message indexing correctness
- RPC response validation

### Infrastructure/Config Security

- Hardcoded secrets or API keys
- Insecure RPC endpoints
- Misconfigured validator sets
- Exposed internal service addresses

### Token Bridge (Warp Routes) Security

- Collateral accounting errors
- Synthetic token minting/burning flaws
- Rate limiting bypass
- Liquidity imbalance exploitation

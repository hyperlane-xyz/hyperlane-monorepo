# CLAUDE.md

This document provides guidance for AI assistants working with the Kaspa-Hub bridge implementation in this repository.

## System Overview

This is a 1-1 backed bridge between Kaspa and the Dymension Hub for the KAS token. The bridge guarantees:

- **No double spending**: Each UTXO can only be spent once
- **No lost funds**: Maintains permanent balance between escrow and minted tokens
- **Eventual liveness**: Works correctly with an eventually honest relayer

## Architecture

### Key Components

1. **Kaspa Chain**: Uses UTXO model with multisig escrow address
2. **Hub Chain**: Uses Hyperlane for minting/burning with Message ID Multisig ISM
3. **Relayer**: Provides liveness by building and submitting transactions
4. **Validator**: Provides safety by verifying and signing transactions
5. **x/kas Module**: Hub module tracking withdrawal state and anchor UTXO

### Core Data Structures

- **Anchor UTXO (O)**: Current unspent transaction output that must be included in next withdrawal
- **Last Processed Index (L)**: Index of last withdrawal confirmed on Kaspa
- **Escrow**: Multisig address on Kaspa holding bridged funds
- **WithdrawFXG**: Bundle containing PSKTs, messages, and anchor tracking

## Correctness Model

### UTXO Chain Invariant

The bridge maintains a linked chain of transactions where:

1. Each transaction spends the previous anchor UTXO
2. Each transaction creates a new anchor UTXO as its last output
3. The anchor ensures exactly-once processing

### State Synchronization Protocol

**Hub State**: `(O_hub, L_hub)` - current anchor and last processed withdrawal

**Kaspa State**: Actual UTXO state which may be ahead of Hub state

**Synchronization**:

1. If `O_hub` is spent on Kaspa, trace the TX chain to find new anchor
2. Update Hub atomically using compare-and-set on `O_hub`
3. Validator verifies trace before signing update

### Message Processing

**Kaspa → Hub (Deposits)**:

- Each deposit includes unique TX outpoint
- Hub maintains "seen" set for replay protection
- Trivial correctness: unique outpoints ensure no double processing

**Hub → Kaspa (Withdrawals)**:

1. Withdrawals queued on Hub
2. Relayer builds TX with `O_hub` as input
3. TX payload contains `L'` (new last processed index)
4. Validator checks: `L_hub < L'` and `O_hub` in inputs
5. New anchor created as last TX output

## Sweeping Mechanism (PR #220)

### Purpose

Consolidates multiple UTXOs to prevent transaction mass constraint failures.

### Trigger Conditions

- Escrow UTXO count exceeds `SWEEPING_THRESHOLD` (default: 3)
- Excludes anchor UTXO from sweeping

### Sweeping Process

1. Extract anchor UTXO from escrow set
2. Create sweeping bundle consolidating non-anchor UTXOs
3. Sweeping TX outputs: consolidated escrow UTXO + relayer change
4. Use swept outputs as inputs for withdrawal TX
5. Anchor UTXO spent only in final withdrawal TX

### Transaction Types

- **Sweeping TX**: No messages, no payload, doesn't spend anchor
- **Withdrawal TX**: Contains messages and payload, spends anchor

## Security Properties

### Double Spend Prevention

- **Kaspa property**: Each UTXO spendable only once
- **Hub property**: Message IDs processed only once (Hyperlane replay protection)
- **Bridge property**: Anchor UTXO ensures sequential processing

### Validator Checks

**For Withdrawals**:

1. Messages dispatched on Hub
2. Messages not yet confirmed
3. Current anchor matches Hub state
4. Amounts match message content
5. Proper message ordering (L < L')

**For Sweeping**:

1. No messages in sweeping TXs
2. Anchor not spent in sweeping
3. Proper UTXO consolidation
4. Fee calculations correct

**For State Updates**:

1. Trace validity from old to new anchor
2. Payload consistency
3. Compare-and-set on anchor update

### Attack Mitigation

1. **Reordering attacks**: Compare-and-set prevents out-of-order updates
2. **Double withdrawal**: Anchor UTXO ensures exactly-once processing
3. **Fee manipulation**: Validators verify fee calculations
4. **UTXO exhaustion**: Sweeping prevents accumulation

## Key Algorithms

### Anchor Tracking

```
Given: current_anchor (O)
1. Check if O is UTXO
2. If spent:
   - Trace TX chain: O → TX1 → ... → TXn → O'
   - Verify each TX in chain
   - Extract L' from TXn payload
   - Update Hub: (O, L) → (O', L') with CAS
3. If UTXO:
   - Process pending withdrawals
```

### UTXO Consolidation (Sweeping)

```
Given: escrow_utxos, threshold
1. If len(escrow_utxos) > threshold:
   - Remove anchor from set
   - Create sweep TX: many_utxos → one_utxo
   - Use swept UTXO for withdrawal
2. Else:
   - Use UTXOs directly for withdrawal
```

## Configuration Parameters

- `SWEEPING_THRESHOLD`: Minimum UTXOs before sweeping (default: 3)
- `TX_MASS_MULTIPLIER`: Safety factor for mass estimation (default: 1.3)
- `RELAYER_SWEEPING_PRIORITY_FEE`: Additional fee for sweeping TXs (default: 3000)
- `MIN_DEPOSIT_SOMPI`: Minimum deposit amount to prevent dust

## Implementation Notes

### Transaction Building

1. Always include anchor UTXO in withdrawal inputs
2. Always create new anchor as last output
3. Include message IDs in payload for tracking
4. Apply feerate from network for accurate fees

### Error Handling

- Use specific error types for different validation failures
- Distinguish between recoverable and fatal errors
- Log validation failures with context

### Testing Considerations

- Test concurrent sweeping attempts
- Verify anchor preservation across all TX types
- Test fee calculation edge cases
- Validate message ordering enforcement

## Common Pitfalls

1. **Anchor Management**: Never spend anchor without creating new one
2. **Message Ordering**: Always verify L' > L before signing
3. **UTXO Selection**: Separate escrow vs relayer UTXOs correctly
4. **Fee Calculation**: Account for multisig size in mass estimation
5. **Sweeping Logic**: Ensure anchor excluded from sweep inputs

## Glossary

- **Anchor**: UTXO that links transactions in sequence
- **Escrow**: Multisig address holding bridged funds
- **FXG**: Withdrawal bundle with PSKTs and messages
- **Mass**: Kaspa's measure of transaction size/complexity
- **Outpoint**: Reference to specific UTXO (txid + index)
- **PSKT**: Partially Signed Kaspa Transaction
- **Sweeping**: Consolidating multiple UTXOs into one
- **Trace**: Sequence of linked transactions

## References

- Kaspa TX structure: https://github.com/kaspanet/rusty-kaspa/blob/eaadfa6230fc376f314d9a504c4c70fbc0416844/consensus/core/src/tx.rs#L168-L187
- Kaspa API: https://api.kaspa.org/docs
- PR #220 (Sweeping): https://github.com/dymensionxyz/hyperlane-monorepo/pull/220
- Issue #214 (TX Mass): https://github.com/dymensionxyz/hyperlane-monorepo/issues/214

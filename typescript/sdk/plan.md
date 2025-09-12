# AccessManager Submitter Implementation Plan

Based on my analysis of the existing submitter architecture and OpenZeppelin's AccessManager contract, here's a comprehensive plan for implementing an AccessManager submitter that can compose with the GnosisSafe submitter:

## Architecture Overview

The AccessManager submitter will follow the existing Hyperlane submitter pattern, implementing `TxSubmitterInterface` and supporting composition with other submitters like GnosisSafe through a configurable proposer pattern.

## Key Components

### 1. Core Submitter Class

- **File**: `EV5AccessManagerTxSubmitter.ts`
- **Type**: `TxSubmitterType.ACCESS_MANAGER`
- **Pattern**: Similar to `EV5TimelockSubmitter.ts` with composition support

### 2. Configuration Interface

- **Role management**: Define required roles and permissions
- **Execution delays**: Per-role or per-function delay configuration
- **Composable proposer**: Support for underlying submitters (JsonRpc, GnosisSafe, etc.)

### 3. Operational Flow

1. **Permission Check**: Verify caller has required role via `canCall()`
2. **Schedule Operations**: Use `schedule()` for delayed operations
3. **Compose with Proposer**: Delegate scheduling transactions to underlying submitter
4. **Execute**: Handle immediate execution or return scheduled execution data

## Implementation Strategy

### Phase 1: Basic AccessManager Submitter

```typescript
// Core implementation
import { keccak256 } from '@ethersproject/keccak256';
import { toUtf8Bytes } from '@ethersproject/strings';

import { IAccessManager__factory } from '@hyperlane-xyz/core';

// Add to TxSubmitterTypes.ts
ACCESS_MANAGER = 'accessManager';

const RESERVED_ROLES = {
  ADMIN: 0n,
  PUBLIC: 2n ** 64n - 1n,
};

export class EV5AccessManagerTxSubmitter implements EV5TxSubmitterInterface {
  txSubmitterType = TxSubmitterType.ACCESS_MANAGER;

  constructor(
    private config: AccessManagerSubmitterConfig,
    private multiProvider: MultiProvider,
    private proposerSubmitter: TxSubmitterInterface<ProtocolType.Ethereum>,
    private accessManager: IAccessManager,
  ) {}

  // Role ID generation using keccak256 hash of role name
  private getRoleId(roleName: string): bigint {
    if (roleName === 'ADMIN') return RESERVED_ROLES.ADMIN;
    if (roleName === 'PUBLIC') return RESERVED_ROLES.PUBLIC;

    const fullHash = keccak256(toUtf8Bytes(roleName));
    return BigInt('0x' + fullHash.slice(2, 18));
  }
}
```

### Phase 2: GnosisSafe Composition

The composability will work through a proposer pattern where:

- **AccessManager** handles permission checks and scheduling logic
- **GnosisSafe** handles the actual transaction proposal and execution
- **Flow**: AccessManager → Schedule → GnosisSafe → Propose → Execute

### Phase 3: Configuration Schema

```typescript
interface AccessManagerSubmitterConfig {
  chain: string;
  accessManagerAddress: string;
  roleName: string; // Role name (e.g., 'DEPLOYER', 'OPERATOR') - ID generated automatically
  proposerSubmitter: TxSubmitterConfig; // Can be GnosisSafe or JsonRpc
  executionDelay?: bigint; // Optional override for role-specific delays
  salt?: string; // For unique operation IDs
}
```

## Key Design Decisions

### 1. Composition Pattern

Following the `EV5TimelockSubmitter` pattern where the AccessManager submitter wraps another submitter (like GnosisSafe) for the actual transaction proposal/execution.

### 2. Permission Strategy

- Check `canCall()` before scheduling
- Support both immediate and delayed execution based on role configuration
- Handle permission errors gracefully with clear error messages

### 3. Operation Management

- Generate unique operation IDs using target, data, and salt
- Track scheduled operations to avoid duplicates
- Support operation cancellation for authorized roles

### 4. Integration Points

- **Builder Integration**: Extend `TxSubmitterBuilder` to support AccessManager configuration
- **Config Validation**: Ensure AccessManager address and role permissions are valid
- **Error Handling**: Provide clear feedback on permission failures and scheduling conflicts

## Implementation Steps

1. **Add AccessManager type** to `TxSubmitterTypes.ts`
2. **Create core submitter class** with clean implementation:
   - Import and use `IAccessManager__factory` from `@hyperlane-xyz/core`
   - Implement role ID generation using keccak256 hashing
   - Follow the composition pattern from `EV5TimelockSubmitter`
3. **Implement GnosisSafe composition** through proposer pattern
4. **Add builder support** for configuration management
5. **Add comprehensive tests** covering permission scenarios and composition
6. **Update documentation** with usage examples

## Benefits of This Approach

- **Composability**: Works seamlessly with existing submitters like GnosisSafe
- **Time-delayed Security**: Leverages AccessManager's built-in delay mechanisms
- **Fine-grained Permissions**: Role-based access control for different operations
- **Consistent API**: Follows existing Hyperlane submitter patterns
- **Flexibility**: Supports both immediate and delayed execution modes

This plan provides a robust foundation for AccessManager integration while maintaining compatibility with Hyperlane's existing transaction submission infrastructure.

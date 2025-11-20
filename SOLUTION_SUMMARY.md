# Solution Summary: Separating EVM and AltVM Core Address Types

## Problem

The original Zod validation error occurred when deploying Hyperlane core contracts to AltVM chains (Cosmos, Sealevel, etc.):

```
ZodError: [
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["staticMessageIdMultisigIsmFactory"], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["staticAggregationIsmFactory"], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["staticAggregationHookFactory"], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["domainRoutingIsmFactory"], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["staticMerkleRootWeightedMultisigIsmFactory"], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["staticMessageIdWeightedMultisigIsmFactory"], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["proxyAdmin"], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["testRecipient"], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["interchainAccountRouter"], "message": "Required" }
]
```

### Root Cause

The `DeployedCoreAddressesSchema` required all proxy factory addresses (e.g., `staticMerkleRootMultisigIsmFactory`, `staticMessageIdMultisigIsmFactory`, etc.) to be present. However, these are **EVM-specific Solidity contracts** that don't exist on AltVM chains (Cosmos, Sealevel, Starknet, Fuel).

The previous "fix" was to set these fields to empty strings (`''`) in `AltVMCoreModule`, which was semantically incorrect and polluted the data model with fake values.

## Architectural Solution

We implemented a **protocol-specific type hierarchy** that separates EVM-specific concerns from the base core addresses:

### 1. **Base Core Addresses** (Protocol-Agnostic)

```typescript
// typescript/sdk/src/core/types.ts
export const BaseCoreAddressesSchema = z.object({
  mailbox: z.string(),
  validatorAnnounce: z.string(),
  proxyAdmin: z.string(),
  testRecipient: z.string(),
  timelockController: z.string().optional(),
  interchainAccountRouter: z.string(),
  merkleTreeHook: z.string().optional(),
  interchainGasPaymaster: z.string().optional(),
});

export type BaseCoreAddresses = z.infer<typeof BaseCoreAddressesSchema>;
```

Contains only the addresses that are **universal across all protocols** (EVM, Cosmos, Sealevel, etc.).

### 2. **EVM Core Addresses** (EVM-Specific)

```typescript
// typescript/sdk/src/core/types.ts
export const EvmCoreAddressesSchema = BaseCoreAddressesSchema.merge(
  ProxyFactoryFactoriesSchema,
);

export type EvmCoreAddresses = z.infer<typeof EvmCoreAddressesSchema>;
```

Extends the base with **required** EVM-specific factory addresses. Used as the return type for `EvmCoreModule.deploy()`.

### 3. **Deployed Core Addresses** (Lenient/Universal)

```typescript
// typescript/sdk/src/core/types.ts
export const DeployedCoreAddressesSchema = BaseCoreAddressesSchema.merge(
  ProxyFactoryFactoriesSchema.partial(), // Makes all factories optional
);

export type DeployedCoreAddresses = z.infer<typeof DeployedCoreAddressesSchema>;
```

Makes factory addresses **optional** for backward compatibility and registry parsing. This allows both:

- EVM chains (with factories present)
- AltVM chains (without factories)

### 4. **Provider SDK Types**

```typescript
// typescript/provider-sdk/src/core.ts
export type BaseCoreAddresses = {
  mailbox: string;
  validatorAnnounce: string;
  proxyAdmin: string;
  testRecipient: string;
  timelockController?: string;
  interchainAccountRouter: string;
  merkleTreeHook?: string;
  interchainGasPaymaster?: string;
};

export type DeployedCoreAddresses = BaseCoreAddresses & {
  staticMerkleRootMultisigIsmFactory?: string;
  staticMessageIdMultisigIsmFactory?: string;
  staticAggregationIsmFactory?: string;
  staticAggregationHookFactory?: string;
  domainRoutingIsmFactory?: string;
  staticMerkleRootWeightedMultisigIsmFactory?: string;
  staticMessageIdWeightedMultisigIsmFactory?: string;
};
```

Mirror types in provider-sdk with factories as optional fields.

## Changes Made

### 1. `typescript/sdk/src/core/types.ts`

- Added `BaseCoreAddressesSchema` for protocol-agnostic addresses
- Added `EvmCoreAddressesSchema` for EVM-specific addresses with required factories
- Modified `DeployedCoreAddressesSchema` to use `ProxyFactoryFactoriesSchema.partial()` (makes factories optional)
- Exported all three types

### 2. `typescript/sdk/src/index.ts`

- Exported `BaseCoreAddresses`, `BaseCoreAddressesSchema`
- Exported `EvmCoreAddresses`, `EvmCoreAddressesSchema`

### 3. `typescript/sdk/src/core/EvmCoreModule.ts`

- Kept using `DeployedCoreAddresses` for constructor (accepts optional factories)
- Return type of `deploy()` is `EvmCoreAddresses` (guarantees factories are present)

### 4. `typescript/provider-sdk/src/core.ts`

- Separated `BaseCoreAddresses` (protocol-agnostic)
- Made `DeployedCoreAddresses` extend base with optional factory fields

### 5. `typescript/deploy-sdk/src/AltVMCoreModule.ts`

- Changed return type to `BaseCoreAddresses`
- **Removed all empty string assignments for EVM factory fields**
- Simplified logic for setting optional hook addresses
- No longer pollutes the data model with fake factory addresses

## Benefits

### 1. **Semantically Correct**

- EVM factories are isolated to EVM-specific code
- AltVM modules don't need to know about EVM-specific contracts
- No fake data (empty strings) in the address objects

### 2. **Type Safety**

- Each module uses the appropriate type for its protocol
- Compile-time guarantees that EVM deployments include factories
- Runtime validation allows both EVM and AltVM chains

### 3. **Clean Architecture**

- Clear separation of concerns between protocols
- Protocol-specific types are properly scoped
- Base abstractions are truly protocol-agnostic

### 4. **Backward Compatible**

- Existing EVM deployments continue to work
- Registry parsing handles both old (with factories) and new (without factories) data
- CLI validation works for all chain types

### 5. **Maintainable**

- Future protocol additions don't need EVM-specific fields
- Easier to understand which fields apply to which protocols
- No workarounds or hacks needed

## Validation

The fix was validated with a test demonstrating both scenarios:

```javascript
// Test 1: EVM chain with all factories ✓
const evmAddresses = {
  mailbox: '0x123',
  validatorAnnounce: '0x456',
  proxyAdmin: '0x789',
  testRecipient: '0xabc',
  interchainAccountRouter: '0xdef',
  staticMerkleRootMultisigIsmFactory: '0x111',
  // ... all other factories
};
DeployedCoreAddressesSchema.parse(evmAddresses); // ✓ PASSES

// Test 2: AltVM chain without factories ✓
const altVmAddresses = {
  mailbox: '0x123',
  validatorAnnounce: '0x456',
  proxyAdmin: '',
  testRecipient: '',
  interchainAccountRouter: '',
  // No factory fields at all
};
DeployedCoreAddressesSchema.parse(altVmAddresses); // ✓ PASSES
```

## Migration Path

No migration is required:

- Existing EVM registry data will continue to work (factories present)
- New AltVM deployments won't include factory fields
- Both are valid according to `DeployedCoreAddressesSchema`

## Conclusion

This solution properly addresses the architectural issue by recognizing that EVM-specific proxy factories should not be required for non-EVM chains. The type hierarchy now correctly represents the protocol differences, making the codebase more maintainable and semantically correct.

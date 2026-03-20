# Migration Guide: Multi-VM Package Restructure (v19.9.0+)

This guide covers changes introduced in PR #7385 which restructures AltVM (Alternative Virtual Machine) functionality into dedicated packages.

## Overview

The Hyperlane SDK has been reorganized to better separate EVM and multi-VM concerns:

- **New Package**: `@hyperlane-xyz/provider-sdk` - Protocol-agnostic provider abstractions and interfaces
- **New Package**: `@hyperlane-xyz/deploy-sdk` - Deployment modules for all VM types (EVM + AltVM)
- **Updated**: `@hyperlane-xyz/sdk` - Core SDK with EVM-specific implementations
- **Updated**: `@hyperlane-xyz/utils` - Shared utilities (no breaking changes)

## Who is Affected?

### ✅ NOT Affected (No Changes Required)

If the client application:

- Only uses EVM chains (Ethereum, Polygon, Arbitrum, etc.)
- Imports from `@hyperlane-xyz/registry`
- Imports from `@hyperlane-xyz/widgets`
- Uses `ProtocolType`, `ChainMetadata`, `MultiProvider` from SDK/utils
- Uses the Warp UI template or Explorer without modifications

**Action**: Upgrade to SDK v19.9.0+ without code changes.

### ⚠️ Affected (Migration Required)

If the client application:

- Deploys or manages Alt-VM chains (Cosmos, Sealevel/Solana, Starknet, Radix)
- Imports `AltVM*` classes directly
- Uses `MinimumRequiredGasByAction` or `GasAction` from utils
- Implements custom AltVM deployment logic

**Action**: Follow migration steps below.

## Breaking Changes

### None for External Consumers

This is a **non-breaking refactor** for external repositories. All commonly-used exports remain in their original locations:

- ✅ `ProtocolType` - Still in `@hyperlane-xyz/utils`
- ✅ `MultiProvider` - Still in `@hyperlane-xyz/sdk`
- ✅ `ChainMetadata` - Still in `@hyperlane-xyz/sdk`
- ✅ All EVM modules - Still in `@hyperlane-xyz/sdk`

### Internal Reorganization

The following exports have been **moved** to new packages:

#### Moved to `@hyperlane-xyz/provider-sdk`

```typescript
// Protocol types and enums
- ProtocolType (also still available in utils)
- AltVM namespace (interfaces and types)
- MinimumRequiredGasByAction
- GasAction

// Core abstractions
- AnnotatedTx
- TxReceipt
- Transaction types
```

#### Moved to `@hyperlane-xyz/deploy-sdk`

```typescript
// Core deployment
import { AltVMCoreModule, AltVMCoreReader } from '@hyperlane-xyz/deploy-sdk';
// Hook deployment
import { AltVMHookModule, AltVMHookReader } from '@hyperlane-xyz/deploy-sdk';
// ISM deployment
import { AltVMIsmModule, AltVMIsmReader } from '@hyperlane-xyz/deploy-sdk';
// Warp deployment
import {
  AltVMDeployer,
  AltVMWarpModule,
  AltVMWarpRouteReader,
} from '@hyperlane-xyz/deploy-sdk';
```

## Migration Steps

### Step 1: Install New Packages if needed

For monorepo internal packages, dependencies are already in place. For external consumers using AltVM features:

```bash
yarn add @hyperlane-xyz/provider-sdk@^0.3.0
yarn add @hyperlane-xyz/deploy-sdk@^0.3.0
```

### Step 2: Update Import Statements

#### AltVM Deployment

Update AltVM modules as indicated above.

```typescript
// Before
import { AltVM } from '@hyperlane-xyz/utils';

// After
import { AltVM } from '@hyperlane-xyz/provider-sdk';
```

#### Gas Action Imports

```typescript
// Before
import { GasAction, MinimumRequiredGasByAction } from '@hyperlane-xyz/utils';

// After
import {
  GasAction,
  MinimumRequiredGasByAction,
} from '@hyperlane-xyz/provider-sdk';
```

#### Protocol Type Imports (No Change Needed)

```typescript
// Before (still works)
import { ProtocolType } from '@hyperlane-xyz/utils';

// After (also works, preferred for new consumers)
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
```

### Step 3: Update Module Instantiation

AltVM modules have updated constructor signatures. The main change is replacing a `multiProvider` with the introduction of `chainLookup` helpers.

## New Features

### Chain Lookup Helper

A new adapter function decouples chain metadata lookup between the SDK and AltVM modules:

```typescript
import { altVmChainLookup } from '@hyperlane-xyz/sdk';

const chainLookup = altVmChainLookup(multiProvider);

// Use with AltVM modules
const coreModule = new AltVMCoreModule(chainLookup, signer, { ... });
```

### Config Utilities

Some utilities for config normalization moved to `@hyperlane-xyz/utils` but are not yet completely removed from the SDK:

```typescript
import { normalizeConfig, sortArraysInConfig } from '@hyperlane-xyz/utils';

const normalized = normalizeConfig(config);
const sorted = sortArraysInConfig(config);
```

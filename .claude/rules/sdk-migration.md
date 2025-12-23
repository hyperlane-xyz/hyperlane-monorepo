# SDK Migration Rules

## Multi-VM Package Structure (v19.9.0+)

For AltVM (Cosmos, Sealevel, Starknet, Radix) development:

| Package                       | Purpose                                 |
| ----------------------------- | --------------------------------------- |
| `@hyperlane-xyz/provider-sdk` | Protocol-agnostic provider abstractions |
| `@hyperlane-xyz/deploy-sdk`   | Deployment modules for all VM types     |
| `@hyperlane-xyz/sdk`          | Core SDK (EVM-specific)                 |

## Migration Reference

See `docs/2025-11-20-multi-vm-migration.md` for full migration guide.

## Quick Import Reference

```typescript
// AltVM deployment (moved from @hyperlane-xyz/sdk)
import {
  AltVMCoreModule,
  AltVMHookModule,
  AltVMIsmModule,
} from '@hyperlane-xyz/deploy-sdk';
// Gas actions (moved from @hyperlane-xyz/utils)
import {
  GasAction,
  MinimumRequiredGasByAction,
} from '@hyperlane-xyz/provider-sdk';
// Chain lookup helper
import { altVmChainLookup } from '@hyperlane-xyz/sdk';
```

## No Changes Needed If

- Only using EVM chains
- Importing from `@hyperlane-xyz/registry` or `@hyperlane-xyz/widgets`
- Using `ProtocolType`, `ChainMetadata`, `MultiProvider` from SDK/utils

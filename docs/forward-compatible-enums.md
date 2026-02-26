# Forward-Compatible Enum Validation

This document explains how the SDK handles unknown enum values from newer registry versions, enabling forward compatibility without breaking older SDK versions.

## Problem Statement

The Hyperlane registry may add new values to enums (e.g., new protocol types, ISM types, hook types) before SDK releases catch up. Without forward compatibility, an older SDK parsing a registry with new enum values would fail Zod validation entirely, blocking all operations even for chains that don't use the new types.

## Solution Architecture

### Two-Pronged Approach

1. **Simple Enums**: Use `forwardCompatibleEnum()` Zod helper that normalizes unknown string values to an `Unknown` variant
2. **Nested Configs**: Use preprocessing functions (`normalizeUnknownHookTypes`, `normalizeUnknownIsmTypes`) to recursively normalize `type` fields before Zod validation

### Affected Enums

| Enum                  | Unknown Variant | Location                                            |
| --------------------- | --------------- | --------------------------------------------------- |
| `ProtocolType`        | `Unknown`       | `@hyperlane-xyz/utils`                              |
| `ExplorerFamily`      | `Unknown`       | `typescript/sdk/src/metadata/chainMetadataTypes.ts` |
| `ChainTechnicalStack` | `Unknown`       | `typescript/sdk/src/metadata/chainMetadataTypes.ts` |
| `TokenType`           | `unknown`       | `typescript/sdk/src/token/config.ts`                |
| `HookType`            | `UNKNOWN`       | `typescript/sdk/src/hook/types.ts`                  |
| `IsmType`             | `UNKNOWN`       | `typescript/sdk/src/ism/types.ts`                   |

### Naming Conventions

Each enum follows its own internal naming convention for consistency:

| Enum Style                | Key Format      | Examples                                          |
| ------------------------- | --------------- | ------------------------------------------------- |
| TypeScript `enum`         | PascalCase      | `ProtocolType.Ethereum`, `ExplorerFamily.Unknown` |
| Const object (hooks/ISMs) | SCREAMING_SNAKE | `HookType.MERKLE_TREE`, `IsmType.UNKNOWN`         |
| Const object (tokens)     | camelCase       | `TokenType.synthetic`, `TokenType.unknown`        |

## Type Aliases

### Deployable Types

These exclude Unknown variants for use in deployment code:

```typescript
// Can be deployed - excludes Unknown
type DeployableHookType = Exclude<HookType, HookType.CUSTOM | HookType.UNKNOWN>;
type DeployableIsmType = Exclude<IsmType, IsmType.CUSTOM | IsmType.UNKNOWN>;
type DeployableTokenType = Exclude<TokenType, TokenType.unknown>;

// Known at runtime - excludes Unknown
type KnownProtocolType = Exclude<ProtocolType, ProtocolType.Unknown>;
```

### When to Use Which Type

| Context                  | Use This Type                                   |
| ------------------------ | ----------------------------------------------- |
| Parsing registry configs | Full type (e.g., `HookType`)                    |
| Deploying contracts      | Deployable type (e.g., `DeployableHookType`)    |
| Building providers       | Known type (e.g., `KnownProtocolType`)          |
| Type-safe mappings       | Deployable/Known types to ensure exhaustiveness |

## Safety Patterns

### Pattern 1: Explicit Assertion (Deployment)

Use when deploying contracts - fail fast with clear error message:

```typescript
// In deployment code
assert(
  ismType !== IsmType.UNKNOWN,
  `Cannot deploy unknown ISM type. Registry contains ISM type not supported by this SDK version.`,
);
const deployableType = ismType as DeployableIsmType;
```

**Used in:**

- `HyperlaneIsmFactory.deploy()`
- `HyperlaneHookDeployer.deployContracts()`
- `HyperlaneCoreDeployer.deployHook()`

### Pattern 2: Early Return Null (Provider Building)

Use when graceful degradation is acceptable:

```typescript
// In provider building code
if (protocol === ProtocolType.Unknown) return null;
```

**Used in:**

- `MultiProtocolProvider.tryGetProvider()`

### Pattern 3: Safe Default (Calculations)

Use when a reasonable default exists:

```typescript
// In gas calculations
case ProtocolType.Unknown:
  return TOKEN_EXCHANGE_RATE_DECIMALS_ALTVM; // Safe middle-ground
```

## Schema Usage

### Basic Parsing (Known Sources)

```typescript
// When source is known to be valid (e.g., internal config)
const result = HookConfigSchema.parse(config);
```

### Safe Parsing (External Sources)

```typescript
// When source may contain unknown types (e.g., registry)
const result = SafeParseHookConfigSchema.parse(config);
// Or manually preprocess:
const normalized = normalizeUnknownHookTypes(config);
const result = HookConfigSchema.parse(normalized);
```

## Adding New Enum Values

When adding a new value to the registry:

1. **SDK Update Required**: Add the new enum value and schema support
2. **Forward Compatibility**: Older SDKs will normalize to `Unknown` and continue working for other chains
3. **Deployment Blocked**: Attempting to deploy the new type with an old SDK will fail with a clear assertion error

## Testing

Tests exclude Unknown types from random config generation to prevent test pollution:

```typescript
// In test utilities
const hookTypes = Object.values(HookType).filter((t) => t !== HookType.UNKNOWN);
```

## Related Files

- `typescript/sdk/src/metadata/customZodTypes.ts` - `forwardCompatibleEnum()` helper
- `typescript/sdk/src/hook/types.ts` - Hook Unknown handling
- `typescript/sdk/src/ism/types.ts` - ISM Unknown handling
- `typescript/sdk/src/token/types.ts` - Token Unknown handling
- `typescript/sdk/src/metadata/forwardCompatibleEnum.test.ts` - Test coverage

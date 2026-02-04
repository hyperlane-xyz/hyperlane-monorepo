Review this pull request. Focus on:

## Code Quality

- Logic errors and potential bugs
- Error handling and edge cases
- Code clarity and maintainability
- Adherence to existing patterns in the codebase
- **Use existing utilities** - Search codebase before adding new helpers
- **Prefer `??` over `||`** - Preserves zero/empty string as valid values
- **Use `assert()` for preconditions** - Import from `@hyperlane-xyz/utils`
- **Use `isNullish()` for null checks** - Type-safe null/undefined check from `@hyperlane-xyz/utils`
- **Async lazy init** - Prefer `LazyAsync` from `@hyperlane-xyz/utils` for cached async initialization

## Architecture

- Consistency with existing architecture patterns
- Breaking changes or backward compatibility issues
- API contract changes
- **Deduplicate** - Move repeated code/types to shared files
- **Extract utilities** - Shared functions belong in utils packages

## Testing

- Test coverage for new/modified code
- Edge cases that should be tested
- **New utility functions need unit tests**
- **CLI changes need e2e tests** - `test:ethereum:e2e`, `test:cosmosnative:e2e`

## Performance

- Unnecessary allocations or computations

## Changesets

- **Required for published packages** - Any change to `typescript/` packages needs a changeset
- **Past tense descriptions** - "Added support for X" not "Add support for X"
- **Describe the why** - Focus on user impact, not implementation details

## TypeScript/SDK Patterns

- **Use `ChainMap<T>`** for per-chain configurations
- **Use `MultiProvider`** for EVM multi-chain provider management
- **Use `MultiProtocolProvider`** for cross-VM abstractions (EVM, Cosmos, Sealevel, etc.)
- **Import types from SDK** - Don't redefine types that exist in `@hyperlane-xyz/sdk`
- **Zod schemas** - Follow existing patterns in `typescript/sdk/src/` for config validation
- **Avoid type casts** - Fix underlying types rather than using `as` assertions
- **No `any` types** - Use `unknown` with type guards if type is truly unknown
- **No unnecessary assertions** - `!` (non-null) and `as` often mask bugs; prefer proper null checks
- **Prefer enums over literals** - Use `Status.Pending` not `'pending'`; enables refactoring and IDE support

## Common TypeScript Anti-Patterns

- **`forEach` with assignment** - `arr.forEach(x => (obj[x] = val))` returns value; use `for-of` with block body
- **`array.sort()` mutates** - Use `[...array].sort()` to avoid mutating input
- **Double-cast `as unknown as X`** - Hides type mismatches; use single cast or fix types
- **Placeholder strings in typed maps** - Don't use `map['placeholder']` when type expects `Address`
- **Duplicate test names** - Two `it('does X')` in same file hides intent; make names distinct
- **Stale test `describe()` strings** - Keep in sync with actual CLI flags/behavior
- **Unused imports** - Remove imports that aren't used
- **`||` for defaults** - `value || fallback` treats `0`/`''` as falsy; use `??` instead

## Solidity Patterns

- **Events for state changes** - All storage mutations should emit events
- **`onlyOwner` on privileged functions** - Check access control modifiers
- **Storage layout** - Upgradeable contracts must preserve storage layout
- **Check-effects-interactions** - External calls after state changes
- **Gas efficiency** - Avoid unnecessary storage writes, use `immutable`/`constant`
- **No magic numbers** - Use named constants for thresholds, limits

## Rust Patterns

- **Feature flags** - New VM support behind feature flags (e.g., `aleo`, `starknet`)
- **Clippy compliance** - `cargo clippy -- -D warnings` must pass
- **Trait implementations** - Follow existing patterns in `hyperlane-core`
- **Error handling** - Use `eyre` for errors, avoid `.unwrap()` in non-test code

## Breaking Changes

- **Interface changes** - Deprecate before removing; add new methods alongside old
- **Storage layout** - Document migration path for upgradeable contracts
- **Config schema changes** - Ensure backward compatibility or migration scripts

Provide actionable feedback with specific line references.
Be concise. For minor style issues, group them together.
Security issues are handled by a separate dedicated review.

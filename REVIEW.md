# Code Review Guidelines

## Always flag

### Solidity

- New external/public functions missing access control modifiers
- Unchecked external calls or missing return value checks
- Storage layout changes in upgradeable contracts without migration handling
- Missing event emissions for state-changing operations
- Use of `transfer`/`send` instead of `.call{value: ...}("")`
- Reentrancy risks: state changes after external calls
- Missing input validation on user-facing functions
- New `selfdestruct` or `delegatecall` usage

### TypeScript

- Introduction of `as` type assertions, `as any`, `as unknown as X`, or `!` non-null assertions
- New `catch (e: any)` blocks (use `unknown` + type guards)
- Secrets or API keys in code or logs
- Missing `assert()` for preconditions that should fail fast
- Silent error swallowing (empty catch blocks or catch-and-ignore)

### Rust

- Unwrap/expect on user-provided or external data without proper error handling
- Missing error context in `.map_err()` chains
- New `unsafe` blocks without justification comments
- Hardcoded secrets or credentials

### Cross-cutting

- Changes to CI/CD pipelines or GitHub Actions without clear justification
- New dependencies added without justification
- Breaking changes to published package interfaces without migration path
- Modified files missing corresponding test updates

## Never flag

- Formatting or style issues (handled by prettier, eslint, solhint, cargo fmt, typos)
- Missing documentation or comments on self-evident code
- Existing patterns that are intentional (check git history if unsure)
- Minor naming preferences when existing convention is followed
- Test file organization choices
- Import ordering

## Skip these paths

- `node_modules/`
- `artifacts/`
- `cache/`
- `dist/`
- `*.lock` files
- `rust/main/config/*.json` (generated chain configs)

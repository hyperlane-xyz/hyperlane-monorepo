---
paths: typescript/**/*.ts, typescript/**/*.tsx
---

# TypeScript Development Rules

## SDK Patterns

- Use `ChainMap<T>` for per-chain configurations
- Use `MultiProvider` for multi-chain provider management
- Import types from `@hyperlane-xyz/sdk` rather than redefining
- Use `MultiProtocolProvider` for cross-VM abstractions

## Testing

- Run `yarn --cwd typescript/sdk test` for SDK tests
- Use `yarn --cwd typescript/sdk test:unit` for unit tests only
- For CLI e2e tests:
  - `yarn --cwd typescript/cli test:ethereum:e2e` (EVM)
  - `yarn --cwd typescript/cli test:cosmosnative:e2e` (Cosmos)
  - `yarn --cwd typescript/cli test:radix:e2e` (Radix)

## Before Committing

- Run `yarn lint` - must pass
- Run `yarn prettier` - auto-formats code
- Run `yarn changeset` if modifying published packages

## Code Style

- Follow existing patterns in the codebase
- Prefer explicit types over `any`
- Use async/await over raw promises
- Keep functions small and focused

## Infrastructure Code (`typescript/infra/`)

- Never expose secrets in code or logs
- Validate RPC endpoints and deployment parameters
- Use config files from `typescript/infra/config/` as examples

# Yarn to pnpm Command Mapping Reference

Quick reference guide for converting Yarn commands to pnpm equivalents.

## Basic Commands

| Yarn Command | pnpm Equivalent | Notes |
|--------------|-----------------|-------|
| `yarn install` | `pnpm install` | Same behavior |
| `yarn install --immutable` | `pnpm install --frozen-lockfile` | CI installs |
| `yarn add <pkg>` | `pnpm add <pkg>` | Add dependency |
| `yarn add -D <pkg>` | `pnpm add -D <pkg>` | Add dev dependency |
| `yarn remove <pkg>` | `pnpm remove <pkg>` | Remove dependency |
| `yarn build` | `pnpm build` | Run build script |
| `yarn test` | `pnpm test` | Run test script |

## Workspace Commands

| Yarn Command | pnpm Equivalent | Notes |
|--------------|-----------------|-------|
| `yarn --cwd <dir> <cmd>` | `pnpm -C <dir> <cmd>` | Run command in directory |
| `yarn --cwd <dir> <cmd>` | `pnpm --filter <workspace> <cmd>` | Run command in workspace (by name) |
| `yarn workspace <name> <cmd>` | `pnpm --filter <name> <cmd>` | Run command in specific workspace |
| `yarn workspace <name> add <pkg>` | `pnpm --filter <name> add <pkg>` | Add dependency to workspace |

## Examples from This Repo

### Current Yarn Commands → pnpm Equivalents

```bash
# Root package.json scripts
yarn --cwd solidity build
→ pnpm -C solidity build
→ pnpm --filter solidity build

yarn --cwd typescript/sdk build
→ pnpm -C typescript/sdk build
→ pnpm --filter @hyperlane-xyz/sdk build

yarn --cwd solidity test
→ pnpm -C solidity test
→ pnpm --filter solidity test

# Workspace commands
yarn workspace @hyperlane-xyz/cli add @google-cloud/pino-logging-gcp-config
→ pnpm --filter @hyperlane-xyz/cli add @google-cloud/pino-logging-gcp-config

# Exec commands
yarn exec prettier --check
→ pnpm exec prettier --check

# Pack commands
yarn pack
→ pnpm pack
```

## CI/CD Specific

| Yarn Command | pnpm Equivalent |
|--------------|-----------------|
| `yarn install --immutable` | `pnpm install --frozen-lockfile` |
| `yarn install` | `pnpm install` |
| `yarn build` | `pnpm build` |
| `yarn test:ci` | `pnpm test:ci` |

## Advanced Features

### Dependency Overrides

**Yarn (package.json):**
```json
{
  "resolutions": {
    "async": "^2.6.4",
    "lodash": "^4.17.21"
  }
}
```

**pnpm (package.json):**
```json
{
  "pnpm": {
    "overrides": {
      "async": "^2.6.4",
      "lodash": "^4.17.21"
    }
  }
}
```

### Patches

**Yarn:**
- Patches in `.yarn/patches/`
- Referenced in `resolutions`:
```json
"resolutions": {
  "typechain@npm:^8.0.0": "patch:typechain@npm%3A8.3.2#~/.yarn/patches/typechain-npm-8.3.2-b02e27439e.patch"
}
```

**pnpm:**
- Patches in `patches/` directory
- Referenced in `package.json`:
```json
{
  "pnpm": {
    "patchedDependencies": {
      "typechain@8.3.2": "patches/typechain@8.3.2.patch"
    }
  }
}
```

### Workspace Configuration

**Yarn (package.json):**
```json
{
  "workspaces": [
    "solhint-plugin",
    "solidity",
    "typescript/*",
    "starknet"
  ]
}
```

**pnpm (pnpm-workspace.yaml):**
```yaml
packages:
  - 'solhint-plugin'
  - 'solidity'
  - 'typescript/*'
  - 'starknet'
```

## Cache Configuration

### Yarn Cache (GitHub Actions)
```yaml
- uses: actions/cache@v4
  with:
    path: |
      **/node_modules
      .yarn
    key: ${{ runner.os }}-yarn-4.5.1-cache-${{ hashFiles('./yarn.lock') }}
```

### pnpm Cache (GitHub Actions)
```yaml
- uses: pnpm/action-setup@v4
  with:
    version: 10.22.0
- uses: actions/cache@v4
  with:
    path: |
      **/node_modules
      ~/.pnpm-store
    key: ${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
```

## Migration Script Example

Here's a sample script to help with migration (run at your own risk, test first):

```bash
#!/bin/bash
# migrate-yarn-to-pnpm.sh

echo "Migrating from Yarn to pnpm..."

# 1. Install pnpm
npm install -g pnpm

# 2. Convert lockfile
echo "Converting yarn.lock to pnpm-lock.yaml..."
pnpm import

# 3. Create pnpm-workspace.yaml
echo "Creating pnpm-workspace.yaml..."
cat > pnpm-workspace.yaml << EOF
packages:
  - 'solhint-plugin'
  - 'solidity'
  - 'typescript/*'
  - 'starknet'
EOF

# 4. Install dependencies
echo "Installing dependencies with pnpm..."
pnpm install

# 5. Test build
echo "Testing build..."
pnpm build

echo "Migration complete! Please review changes and test thoroughly."
```

## Common Issues & Solutions

### Issue: "Cannot find module" errors
**Solution**: pnpm is stricter about dependencies. Make sure all dependencies are declared in `package.json`.

### Issue: Workspace filtering not working
**Solution**: Use workspace names from `package.json` (e.g., `@hyperlane-xyz/cli`) not directory paths.

### Issue: CI cache not working
**Solution**: Update cache paths to include `~/.pnpm-store` and use `pnpm-lock.yaml` as cache key.

### Issue: Scripts fail with pnpm
**Solution**: Some scripts may need `pnpm exec` prefix or workspace filtering adjustments.

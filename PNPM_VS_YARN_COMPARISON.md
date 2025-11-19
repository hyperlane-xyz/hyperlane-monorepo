# Yarn vs pnpm Feature Comparison

Detailed comparison of features used in this repository and their equivalents.

## Core Features

| Feature | Yarn 4.5.1 | pnpm 10.x | Status |
|---------|------------|----------|--------|
| Workspaces | ✅ `workspaces` in package.json | ✅ `pnpm-workspace.yaml` | ✅ Compatible |
| Dependency Overrides | ✅ `resolutions` | ✅ `pnpm.overrides` | ✅ Compatible |
| Patches | ✅ `.yarn/patches/` | ✅ `patches/` + `patchedDependencies` | ✅ Compatible |
| Lockfile | ✅ `yarn.lock` | ✅ `pnpm-lock.yaml` | ⚠️ Different format |
| Node Modules Linker | ✅ `nodeLinker: node-modules` | ✅ Default (hoisted) | ✅ Compatible |
| Workspace Protocol | ✅ `workspace:^` | ✅ `workspace:^` | ✅ Compatible |

## Command Comparison

### Installation

| Task | Yarn | pnpm |
|------|------|------|
| Install dependencies | `yarn install` | `pnpm install` |
| CI install (immutable) | `yarn install --immutable` | `pnpm install --frozen-lockfile` |
| Install without scripts | `yarn install --ignore-scripts` | `pnpm install --ignore-scripts` |
| Clean install | `yarn install --force` | `pnpm install --force` |

### Workspace Commands

| Task | Yarn | pnpm |
|------|------|------|
| Run in directory | `yarn --cwd <dir> <cmd>` | `pnpm -C <dir> <cmd>` |
| Run in workspace | `yarn workspace <name> <cmd>` | `pnpm --filter <name> <cmd>` |
| Add to workspace | `yarn workspace <name> add <pkg>` | `pnpm --filter <name> add <pkg>` |
| Run in all workspaces | `yarn workspaces run <cmd>` | `pnpm -r <cmd>` |

### Package Management

| Task | Yarn | pnpm |
|------|------|------|
| Add dependency | `yarn add <pkg>` | `pnpm add <pkg>` |
| Add dev dependency | `yarn add -D <pkg>` | `pnpm add -D <pkg>` |
| Remove dependency | `yarn remove <pkg>` | `pnpm remove <pkg>` |
| Update dependencies | `yarn upgrade` | `pnpm update` |
| Check outdated | `yarn outdated` | `pnpm outdated` |

### Execution

| Task | Yarn | pnpm |
|------|------|------|
| Run script | `yarn <script>` | `pnpm <script>` |
| Execute binary | `yarn exec <cmd>` | `pnpm exec <cmd>` |
| Pack package | `yarn pack` | `pnpm pack` |
| Publish | `yarn publish` | `pnpm publish` |

## Configuration Files

### Yarn Configuration (.yarnrc.yml)

```yaml
compressionLevel: mixed
enableGlobalCache: false
enableScripts: false
nodeLinker: node-modules
plugins:
  - path: .yarn/plugins/@yarnpkg/plugin-outdated.cjs
    spec: 'https://mskelton.dev/yarn-outdated/v3'
yarnPath: .yarn/releases/yarn-4.5.1.cjs
```

### pnpm Configuration (.npmrc)

```ini
# Compression handled automatically
# Global cache disabled by default (uses local store)
# Scripts enabled by default (can disable with ignore-scripts=true)
# Node modules linker is default

# Store location
store-dir=~/.pnpm-store

# Optional: disable scripts during install
# ignore-scripts=true
```

## Workspace Configuration

### Yarn (package.json)

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

### pnpm (pnpm-workspace.yaml)

```yaml
packages:
  - 'solhint-plugin'
  - 'solidity'
  - 'typescript/*'
  - 'starknet'
```

## Dependency Overrides

### Yarn (package.json)

```json
{
  "resolutions": {
    "async": "^2.6.4",
    "lodash": "^4.17.21"
  }
}
```

### pnpm (package.json)

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

## Patches

### Yarn

**Structure:**
```
.yarn/patches/
  └── typechain-npm-8.3.2-b02e27439e.patch
```

**Reference (package.json):**
```json
{
  "resolutions": {
    "typechain@npm:^8.0.0": "patch:typechain@npm%3A8.3.2#~/.yarn/patches/typechain-npm-8.3.2-b02e27439e.patch"
  }
}
```

**Reference (devDependencies):**
```json
{
  "devDependencies": {
    "typechain": "patch:typechain@npm%3A8.3.2#~/.yarn/patches/typechain-npm-8.3.2-b02e27439e.patch"
  }
}
```

### pnpm

**Structure:**
```
patches/
  └── typechain@8.3.2.patch
```

**Reference (package.json):**
```json
{
  "pnpm": {
    "patchedDependencies": {
      "typechain@8.3.2": "patches/typechain@8.3.2.patch"
    }
  }
}
```

**Reference (devDependencies):**
```json
{
  "devDependencies": {
    "typechain": "^8.3.2"
  }
}
```

## CI/CD Caching

### Yarn Cache (GitHub Actions)

```yaml
- uses: actions/cache@v4
  with:
    path: |
      **/node_modules
      .yarn
    key: ${{ runner.os }}-yarn-4.5.1-cache-${{ hashFiles('./yarn.lock') }}
    restore-keys: |
      ${{ runner.os }}-yarn-4.5.1-cache-
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
    restore-keys: |
      ${{ runner.os }}-pnpm-
```

## Performance Comparison

| Metric | Yarn 4.5.1 | pnpm 10.x | Winner |
|--------|------------|----------|--------|
| Install Speed | Fast | Faster | 🏆 pnpm |
| Disk Usage | Moderate | Lower | 🏆 pnpm |
| CI Speed | Fast | Faster | 🏆 pnpm |
| Strictness | Moderate | High | 🏆 pnpm |
| Compatibility | High | High | 🤝 Tie |

## Plugin System

### Yarn Plugins

Yarn uses a plugin system:
- `.yarn/plugins/@yarnpkg/plugin-workspace-tools.cjs`
- `.yarn/plugins/@yarnpkg/plugin-version.cjs`
- `.yarn/plugins/@yarnpkg/plugin-outdated.cjs`

### pnpm Built-ins

pnpm has built-in equivalents:
- Workspace tools: Built-in filtering (`--filter`)
- Version management: Changesets compatible
- Outdated check: `pnpm outdated` built-in

## Migration Complexity

| Aspect | Complexity | Notes |
|--------|------------|-------|
| Configuration | Low | Straightforward conversion |
| Scripts | Medium | Many `yarn --cwd` to convert |
| CI/CD | High | Many workflow files to update |
| Lockfile | Low | `pnpm import` handles conversion |
| Patches | Low | Simple file move + config update |
| Documentation | Medium | Multiple files to update |

## Decision Matrix

### Choose Yarn if:
- ✅ Current setup works well
- ✅ Team is familiar with Yarn
- ✅ Don't want migration effort
- ✅ Yarn 4.5.1 performance is sufficient

### Choose pnpm if:
- ✅ Want better CI performance
- ✅ Need stricter dependency management
- ✅ Want to reduce disk usage
- ✅ Willing to invest in migration
- ✅ Want modern tooling

## Real-World Usage in This Repo

### Current Yarn Usage Patterns

1. **Root Scripts**: `yarn --cwd`, `yarn changeset`, `yarn build`
2. **Workspace Scripts**: `yarn version:update`, `yarn hardhat-esm`
3. **CI/CD**: `yarn install --immutable`, `yarn build`, `yarn test`
4. **Docker**: `yarn install`, `yarn build`
5. **Shell Scripts**: `yarn tsx`, `yarn workspace`

### Equivalent pnpm Patterns

1. **Root Scripts**: `pnpm -C`, `pnpm changeset`, `pnpm build`
2. **Workspace Scripts**: `pnpm version:update`, `pnpm hardhat-esm`
3. **CI/CD**: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`
4. **Docker**: `pnpm install --frozen-lockfile`, `pnpm build`
5. **Shell Scripts**: `pnpm tsx`, `pnpm --filter`

## Conclusion

Both package managers are excellent choices. The migration is **technically feasible** but requires **significant effort** (~20-30 hours). The decision should be based on:

1. **Current pain points**: Are there issues with Yarn?
2. **Performance needs**: Is CI speed critical?
3. **Team capacity**: Can you invest in migration?
4. **Future plans**: Long-term tooling strategy

For this repository, **staying with Yarn 4.5.1 is recommended** unless there are specific pain points, as:
- Current setup works well
- Yarn 4.5.1 is modern and performant
- Migration effort is substantial
- Risk of breaking changes exists

If migrating, follow the detailed guide in `PNPM_MIGRATION_GUIDE.md`.

# PNPM Migration Investigation

## Executive Summary

This document investigates the feasibility of migrating the Hyperlane monorepo from Yarn 4.5.1 to pnpm. The investigation covers current Yarn usage, compatibility considerations, migration challenges, and recommendations.

## Current Yarn Setup

### Version & Configuration
- **Yarn Version**: 4.5.1 (Berry/modern Yarn)
- **Package Manager**: Specified in `package.json` as `"packageManager": "yarn@4.5.1"`
- **Configuration File**: `.yarnrc.yml`
- **Lockfile**: `yarn.lock`
- **Workspace Structure**: Yarn workspaces configured in root `package.json`

### Yarn-Specific Features in Use

#### 1. **Workspaces**
- Root `package.json` defines workspaces:
  ```json
  "workspaces": [
    "solhint-plugin",
    "solidity",
    "typescript/*",
    "starknet"
  ]
  ```
- **pnpm compatibility**: ✅ Fully supported via `pnpm-workspace.yaml`

#### 2. **Dependency Resolutions/Overrides**
- Root `package.json` uses `resolutions` field:
  ```json
  "resolutions": {
    "async": "^2.6.4",
    "fetch-ponyfill": "^7.1",
    // ... more resolutions
  }
  ```
- **pnpm compatibility**: ✅ Supported via `pnpm.overrides` field in `package.json`

#### 3. **Yarn Patches**
- Patches directory: `.yarn/patches/`
- Example: `typechain-npm-8.3.2-b02e27439e.patch`
- **pnpm compatibility**: ✅ Supported via `pnpm.patchedDependencies` in `package.json`

#### 4. **Yarn Plugins**
- `.yarn/plugins/` contains:
  - `@yarnpkg/plugin-workspace-tools.cjs`
  - `@yarnpkg/plugin-version.cjs`
  - `@yarnpkg/plugin-outdated.cjs`
- **pnpm compatibility**: ⚠️ Not directly compatible - pnpm has different plugin system or built-in equivalents

#### 5. **Yarn Commands Used**

| Command | Usage | pnpm Equivalent |
|---------|-------|----------------|
| `yarn install` | Standard install | `pnpm install` |
| `yarn install --immutable` | CI installs | `pnpm install --frozen-lockfile` |
| `yarn --cwd <dir> <cmd>` | Run command in workspace | `pnpm --filter <workspace> <cmd>` or `pnpm -C <dir> <cmd>` |
| `yarn workspace <name> <cmd>` | Run command in specific workspace | `pnpm --filter <name> <cmd>` |
| `yarn exec <cmd>` | Execute binary | `pnpm exec <cmd>` |
| `yarn pack` | Create tarball | `pnpm pack` |
| `yarn build` | Build via turbo | `pnpm build` (same) |
| `yarn changeset` | Changesets integration | `pnpm changeset` (same) |

#### 6. **Configuration Options**
- `.yarnrc.yml` settings:
  - `compressionLevel: mixed`
  - `enableGlobalCache: false`
  - `enableScripts: false`
  - `nodeLinker: node-modules`
- **pnpm compatibility**: ✅ Most have equivalents in `.npmrc` or `pnpm-workspace.yaml`

## CI/CD Integration

### GitHub Actions
- **Custom Actions**: 
  - `.github/actions/yarn-cache/` - Caches yarn dependencies
  - `.github/actions/yarn-build-with-cache/` - Builds with caching
- **Workflows using yarn**:
  - `test.yml` - Multiple jobs use `yarn install`, `yarn build`, `yarn test`, `yarn --cwd`
  - `release.yml` - Uses `yarn install --immutable`, `yarn version:prepare`, `yarn release`
  - `static-analysis.yml` - Uses yarn cache and install
  - Multiple other workflows

### Docker
- `Dockerfile` uses:
  - `yarn set version 4.5.1`
  - `yarn install`
  - `yarn build`
- `docker-entrypoint.sh` uses:
  - `yarn workspace @hyperlane-xyz/cli add ...`

## Migration Considerations

### ✅ Advantages of pnpm

1. **Performance**: Generally faster installs, especially in CI
2. **Disk Space**: Content-addressable storage reduces disk usage
3. **Strict Dependency Resolution**: Better at preventing phantom dependencies
4. **Monorepo Support**: Excellent workspace support with filtering
5. **Turbo Compatibility**: Fully compatible with Turborepo

### ⚠️ Challenges & Required Changes

#### 1. **Lockfile Migration**
- Need to convert `yarn.lock` → `pnpm-lock.yaml`
- Can use `pnpm import` to convert, but may need manual verification
- All developers need to regenerate lockfile

#### 2. **Script Updates**
- Replace all `yarn --cwd` with `pnpm -C` or `pnpm --filter`
- Replace `yarn workspace` with `pnpm --filter`
- Update `yarn exec` to `pnpm exec`
- Update `yarn install --immutable` to `pnpm install --frozen-lockfile`

#### 3. **CI/CD Updates**
- Update all GitHub Actions workflows
- Rewrite custom cache actions (pnpm uses different cache structure)
- Update Dockerfile
- Update docker-entrypoint.sh

#### 4. **Configuration Migration**
- Create `pnpm-workspace.yaml` from workspaces config
- Convert `.yarnrc.yml` settings to `.npmrc` or `pnpm-workspace.yaml`
- Convert `resolutions` to `pnpm.overrides`
- Convert patches to `pnpm.patchedDependencies` format

#### 5. **Plugin Equivalents**
- `plugin-workspace-tools`: pnpm has built-in workspace filtering
- `plugin-version`: Need to check changesets compatibility
- `plugin-outdated`: pnpm has `pnpm outdated` built-in

#### 6. **Documentation Updates**
- Update `CLAUDE.md` with pnpm commands
- Update `README.md`
- Update any other docs referencing yarn

## Compatibility Assessment

### ✅ Fully Compatible
- Workspaces
- Dependency overrides/resolutions
- Patches
- Turbo/turborepo
- Changesets
- Standard npm scripts

### ⚠️ Requires Changes
- Command syntax (`--cwd`, `workspace`)
- CI caching mechanisms
- Lockfile format
- Configuration files

### ❌ Not Compatible (Need Alternatives)
- Yarn-specific plugins (but pnpm has built-in equivalents)
- Yarn's PnP mode (not used anyway - using node-modules linker)

## Migration Effort Estimate

### High-Level Tasks

1. **Configuration Migration** (2-4 hours)
   - Create `pnpm-workspace.yaml`
   - Convert `.yarnrc.yml` → `.npmrc`
   - Convert `resolutions` → `pnpm.overrides`
   - Convert patches → `pnpm.patchedDependencies`

2. **Lockfile Migration** (1-2 hours)
   - Run `pnpm import` to convert `yarn.lock`
   - Verify and test installation
   - Commit new `pnpm-lock.yaml`

3. **Script Updates** (4-6 hours)
   - Update all `package.json` scripts
   - Update root scripts
   - Test all commands

4. **CI/CD Updates** (6-8 hours)
   - Update all GitHub Actions workflows (~15+ files)
   - Rewrite cache actions
   - Update Dockerfile
   - Update docker-entrypoint.sh
   - Test CI pipelines

5. **Documentation Updates** (2-3 hours)
   - Update CLAUDE.md
   - Update README.md
   - Update any other docs

6. **Testing & Validation** (4-6 hours)
   - Test local development workflow
   - Test CI pipelines
   - Test Docker builds
   - Verify all scripts work

**Total Estimated Effort**: 19-29 hours (~2.5-3.5 days)

## Risk Assessment

### Low Risk
- Workspace functionality (well-supported in pnpm)
- Standard npm scripts
- Turbo integration

### Medium Risk
- CI/CD pipeline changes (extensive but straightforward)
- Lockfile conversion (may need manual fixes)
- Developer workflow changes (training needed)

### High Risk
- Breaking changes if migration incomplete
- CI failures if cache/commands not updated
- Developer confusion during transition period

## Recommendations

### Option 1: Full Migration (Recommended if Benefits Justified)
**Pros:**
- Better performance in CI
- Reduced disk usage
- Stricter dependency management
- Modern tooling

**Cons:**
- Significant migration effort (~20-30 hours)
- Risk of breaking changes
- Team needs to learn pnpm commands
- All CI/CD needs updates

**When to choose**: If you're experiencing yarn performance issues, want stricter dependency management, or plan to scale the monorepo significantly.

### Option 2: Stay with Yarn (Recommended if Current Setup Works)
**Pros:**
- No migration effort
- Team already familiar
- Current setup is working
- Yarn 4.5.1 is modern and performant

**Cons:**
- Missing pnpm benefits (if they matter)
- Slightly slower than pnpm in some scenarios

**When to choose**: If current yarn setup is working well and there are no pressing issues.

### Option 3: Hybrid Approach (Not Recommended)
- Use pnpm for new projects only
- Keep yarn for existing monorepo
- **Not recommended** due to complexity and confusion

## Migration Checklist (If Proceeding)

- [ ] Create `pnpm-workspace.yaml`
- [ ] Convert `.yarnrc.yml` settings to pnpm equivalents
- [ ] Convert `resolutions` to `pnpm.overrides`
- [ ] Convert patches to `pnpm.patchedDependencies`
- [ ] Run `pnpm import` to convert lockfile
- [ ] Update all `package.json` scripts
- [ ] Update root `package.json` scripts
- [ ] Update all GitHub Actions workflows
- [ ] Rewrite yarn-cache action for pnpm
- [ ] Update Dockerfile
- [ ] Update docker-entrypoint.sh
- [ ] Update CLAUDE.md
- [ ] Update README.md
- [ ] Test local development workflow
- [ ] Test CI pipelines
- [ ] Test Docker builds
- [ ] Remove `.yarn/` directory
- [ ] Remove `yarn.lock`
- [ ] Update `packageManager` field in `package.json`
- [ ] Communicate changes to team

## Conclusion

**Migration is technically feasible** - pnpm supports all the features currently used (workspaces, overrides, patches, etc.). However, it requires **significant effort (~20-30 hours)** to update all scripts, CI/CD, Docker, and documentation.

**Recommendation**: Unless there are specific pain points with Yarn (performance, disk usage, dependency issues), **staying with Yarn 4.5.1 is the safer choice** given:
1. Current setup is working well
2. Yarn 4.5.1 is modern and performant
3. Migration effort is substantial
4. Risk of breaking changes during migration

If proceeding with migration, plan for:
- A dedicated migration branch
- Comprehensive testing
- Team communication and training
- Rollback plan

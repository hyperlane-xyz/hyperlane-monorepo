# Step-by-Step PNPM Migration Guide

This guide provides detailed steps for migrating from Yarn 4.5.1 to pnpm, with actual code examples from this repository.

## Prerequisites

- Node.js >= 16 (already required)
- Backup your current state: `git commit -am "Backup before pnpm migration"`
- Create a migration branch: `git checkout -b migrate-to-pnpm`

## Phase 1: Configuration Migration

### Step 1.1: Create pnpm-workspace.yaml

Create `pnpm-workspace.yaml` in the root:

```yaml
packages:
  - 'solhint-plugin'
  - 'solidity'
  - 'typescript/*'
  - 'starknet'
```

### Step 1.2: Convert resolutions to pnpm.overrides

**Current (`package.json`):**

```json
{
  "resolutions": {
    "async": "^2.6.4",
    "fetch-ponyfill": "^7.1",
    "flat": "^5.0.2",
    "globals": "^14.0.0",
    "lodash": "^4.17.21",
    "recursive-readdir": "^2.2.3",
    "underscore": "^1.13",
    "undici": "^5.11",
    "@trivago/prettier-plugin-sort-imports/@babel/parser": "^7.22.7",
    "@typechain/ethers-v5": "11.1.2",
    "typechain@npm:^8.0.0": "patch:typechain@npm%3A8.3.2#~/.yarn/patches/typechain-npm-8.3.2-b02e27439e.patch",
    "node-fetch": "^3.3.2"
  }
}
```

**New (`package.json`):**

```json
{
  "pnpm": {
    "overrides": {
      "async": "^2.6.4",
      "fetch-ponyfill": "^7.1",
      "flat": "^5.0.2",
      "globals": "^14.0.0",
      "lodash": "^4.17.21",
      "recursive-readdir": "^2.2.3",
      "underscore": "^1.13",
      "undici": "^5.11",
      "@trivago/prettier-plugin-sort-imports/@babel/parser": "^7.22.7",
      "@typechain/ethers-v5": "11.1.2",
      "node-fetch": "^3.3.2"
    },
    "patchedDependencies": {
      "typechain@8.3.2": "patches/typechain@8.3.2.patch"
    }
  }
}
```

### Step 1.3: Convert Yarn Patch to pnpm Patch

1. Create `patches/` directory: `mkdir -p patches`
2. Copy patch file:
   ```bash
   cp .yarn/patches/typechain-npm-8.3.2-b02e27439e.patch patches/typechain@8.3.2.patch
   ```
3. Update patch format if needed (pnpm uses standard patch format)

### Step 1.4: Create .npmrc for pnpm Configuration

Create `.npmrc` in root:

```ini
# Equivalent to .yarnrc.yml settings
# compressionLevel: mixed -> handled automatically
# enableGlobalCache: false -> use local cache
# enableScripts: false -> equivalent to ignore-scripts
# nodeLinker: node-modules -> default for pnpm

# Disable scripts during install (equivalent to enableScripts: false)
ignore-scripts=true

# Use node_modules linker (default, but explicit)
node-linker=hoisted

# Store location (local, not global)
store-dir=~/.pnpm-store
```

### Step 1.5: Update packageManager Field

**Current (`package.json`):**

```json
{
  "packageManager": "yarn@4.5.1"
}
```

**New (`package.json`):**

```json
{
  "packageManager": "pnpm@10.22.0"
}
```

## Phase 2: Script Updates

### Step 2.1: Update Root package.json Scripts

**Current:**

```json
{
  "scripts": {
    "agent-configs": "yarn --cwd typescript/infra/ update-agent-config:mainnet3 && yarn --cwd typescript/infra/ update-agent-config:testnet4",
    "version:prepare": "yarn changeset version && turbo run version:update && yarn install --no-immutable",
    "version:check": "yarn changeset status",
    "release": "yarn build && yarn changeset publish"
  }
}
```

**New:**

```json
{
  "scripts": {
    "agent-configs": "pnpm -C typescript/infra update-agent-config:mainnet3 && pnpm -C typescript/infra update-agent-config:testnet4",
    "version:prepare": "pnpm changeset version && turbo run version:update && pnpm install",
    "version:check": "pnpm changeset status",
    "release": "pnpm build && pnpm changeset publish"
  }
}
```

### Step 2.2: Update solidity/package.json Scripts

**Current:**

```json
{
  "scripts": {
    "build": "yarn version:update && yarn hardhat-esm compile && tsc && ./exportBuildArtifact.sh",
    "test": "yarn version:exhaustive && yarn hardhat-esm test && yarn test:forge",
    "test:ci": "yarn version:changed && yarn test:hardhat && yarn test:forge --no-match-test testFork",
    "version:changed": "yarn version:update && git diff --exit-code contracts/PackageVersioned.sol"
  }
}
```

**New:**

```json
{
  "scripts": {
    "build": "pnpm version:update && pnpm hardhat-esm compile && tsc && ./exportBuildArtifact.sh",
    "test": "pnpm version:exhaustive && pnpm hardhat-esm test && pnpm test:forge",
    "test:ci": "pnpm version:changed && pnpm test:hardhat && pnpm test:forge --no-match-test testFork",
    "version:changed": "pnpm version:update && git diff --exit-code contracts/PackageVersioned.sol"
  }
}
```

### Step 2.3: Update typescript/cli/package.json Scripts

**Current:**

```json
{
  "scripts": {
    "build": "yarn version:update && tsc",
    "dev": "yarn version:update && tsc --watch"
  }
}
```

**New:**

```json
{
  "scripts": {
    "build": "pnpm version:update && tsc",
    "dev": "pnpm version:update && tsc --watch"
  }
}
```

## Phase 3: Lockfile Migration

### Step 3.1: Install pnpm

```bash
npm install -g pnpm@latest
# Or use corepack (recommended)
corepack enable
corepack prepare pnpm@latest --activate
```

### Step 3.2: Convert Lockfile

```bash
# This will read yarn.lock and create pnpm-lock.yaml
pnpm import
```

### Step 3.3: Verify Installation

```bash
# Remove node_modules and reinstall
rm -rf node_modules **/node_modules
pnpm install
```

### Step 3.4: Test Build

```bash
pnpm build
```

## Phase 4: CI/CD Updates

### Step 4.1: Update GitHub Actions Cache

**Current (`.github/actions/yarn-cache/action.yml`):**

```yaml
- uses: actions/cache@v4
  with:
    path: |
      **/node_modules
      .yarn
    key: ${{ runner.os }}-yarn-4.5.1-cache-${{ hashFiles('./yarn.lock') }}
```

**New (`.github/actions/pnpm-cache/action.yml`):**

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

### Step 4.2: Update yarn-build-with-cache Action

**Current (`.github/actions/yarn-build-with-cache/action.yml`):**

```yaml
- name: Install dependencies
  if: steps.yarn-cache.outputs.cache-hit != 'true'
  shell: bash
  run: |
    yarn install
    CHANGES=$(git status -s --ignore-submodules | grep -v "results.sarif")
    if [[ ! -z $CHANGES ]]; then
      echo "Changes found: $CHANGES"
      git diff
      exit 1
    fi

- name: Build
  shell: bash
  run: yarn build
```

**New (`.github/actions/pnpm-build-with-cache/action.yml`):**

```yaml
- name: pnpm-cache
  id: pnpm-cache
  uses: ./.github/actions/pnpm-cache

- name: Install dependencies
  if: steps.pnpm-cache.outputs.cache-hit != 'true'
  shell: bash
  run: |
    pnpm install --frozen-lockfile
    CHANGES=$(git status -s --ignore-submodules | grep -v "results.sarif")
    if [[ ! -z $CHANGES ]]; then
      echo "Changes found: $CHANGES"
      git diff
      exit 1
    fi

- name: Build
  shell: bash
  run: pnpm build
```

### Step 4.3: Update test.yml Workflow

Replace all instances:

- `yarn install` → `pnpm install --frozen-lockfile`
- `yarn install --immutable` → `pnpm install --frozen-lockfile`
- `yarn build` → `pnpm build`
- `yarn test` → `pnpm test`
- `yarn --cwd <dir> <cmd>` → `pnpm -C <dir> <cmd>`
- `yarn exec <cmd>` → `pnpm exec <cmd>`
- `yarn syncpack` → `pnpm syncpack`
- `yarn lint` → `pnpm lint`
- `yarn changeset` → `pnpm changeset`

### Step 4.4: Update release.yml Workflow

**Current:**

```yaml
- name: Install Dependencies
  run: yarn install --immutable

- name: Create Release PR
  uses: changesets/action@v1
  with:
    version: yarn version:prepare

- name: Publish Release to NPM
  uses: changesets/action@v1
  with:
    version: yarn version:prepare
    publish: yarn release
```

**New:**

```yaml
- name: Setup pnpm
  uses: pnpm/action-setup@v4
  with:
    version: 10.22.0

- name: Install Dependencies
  run: pnpm install --frozen-lockfile

- name: Create Release PR
  uses: changesets/action@v1
  with:
    version: pnpm version:prepare

- name: Publish Release to NPM
  uses: changesets/action@v1
  with:
    version: pnpm version:prepare
    publish: pnpm release
```

## Phase 5: Docker Updates

### Step 5.1: Update Dockerfile

**Current:**

```dockerfile
RUN apk add --update --no-cache git g++ make py3-pip jq bash curl && \
    yarn set version 4.5.1

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/plugins ./.yarn/plugins
COPY .yarn/releases ./.yarn/releases
COPY .yarn/patches ./.yarn/patches

RUN yarn install && yarn cache clean
```

**New:**

```dockerfile
RUN apk add --update --no-cache git g++ make py3-pip jq bash curl && \
    npm install -g pnpm@10.22.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches

RUN pnpm install --frozen-lockfile && pnpm store prune
```

### Step 5.2: Update docker-entrypoint.sh

**Current:**

```bash
yarn workspace @hyperlane-xyz/cli add @google-cloud/pino-logging-gcp-config
```

**New:**

```bash
pnpm --filter @hyperlane-xyz/cli add @google-cloud/pino-logging-gcp-config
```

## Phase 6: Shell Script Updates

### Step 6.1: Update typescript/infra/fork.sh

**Current:**

```bash
LOG_LEVEL=error yarn tsx ./scripts/run-anvil.ts -e $ENVIRONMENT -c $CHAIN &
```

**New:**

```bash
LOG_LEVEL=error pnpm tsx ./scripts/run-anvil.ts -e $ENVIRONMENT -c $CHAIN &
```

### Step 6.2: Update .husky/pre-commit

**Current:**

```bash
yarn lint-staged
echo "📝 If you haven't yet, please add a changeset for your changes via 'yarn changeset'"
```

**New:**

```bash
pnpm lint-staged
echo "📝 If you haven't yet, please add a changeset for your changes via 'pnpm changeset'"
```

## Phase 7: Documentation Updates

### Step 7.1: Update CLAUDE.md

Replace all `yarn` commands with `pnpm` equivalents:

- `yarn install` → `pnpm install`
- `yarn --cwd <dir> <cmd>` → `pnpm -C <dir> <cmd>`
- `yarn build` → `pnpm build`
- etc.

### Step 7.2: Update README.md

**Current:**

```markdown
yarn install
yarn build
```

**New:**

```markdown
pnpm install
pnpm build
```

### Step 7.3: Update Package READMEs

Update all `typescript/*/README.md` files that reference yarn.

## Phase 8: Cleanup

### Step 8.1: Remove Yarn Files

```bash
rm -rf .yarn/
rm yarn.lock
rm .yarnrc.yml
```

### Step 8.2: Update .gitignore

Remove yarn-specific entries, add pnpm-specific:

```gitignore
# pnpm
.pnpm-store/
pnpm-debug.log*
```

### Step 8.3: Update .dockerignore

Remove yarn-specific entries if present.

## Phase 9: Testing Checklist

- [ ] `pnpm install` completes successfully
- [ ] `pnpm build` completes successfully
- [ ] `pnpm test` runs all tests
- [ ] `pnpm lint` works
- [ ] `pnpm -C solidity build` works
- [ ] `pnpm --filter @hyperlane-xyz/cli build` works
- [ ] CI workflows pass
- [ ] Docker build succeeds
- [ ] Local development workflow works
- [ ] Changesets work (`pnpm changeset`)
- [ ] Release process works

## Phase 10: Rollout Strategy

1. **Create Migration Branch**: `git checkout -b migrate-to-pnpm`
2. **Complete All Phases**: Follow steps above
3. **Test Thoroughly**: Run full test suite locally
4. **Open Draft PR**: Create PR with `[WIP]` prefix
5. **CI Testing**: Ensure all CI checks pass
6. **Team Review**: Get team approval
7. **Merge**: Merge to main
8. **Communication**: Notify team of changes
9. **Monitor**: Watch for issues in first few days

## Troubleshooting

### Issue: "Cannot find module" errors

**Solution**: pnpm is stricter. Ensure all dependencies are in `package.json`. Run `pnpm install` to verify.

### Issue: Workspace dependencies not resolving

**Solution**: Use workspace names from `package.json` (e.g., `@hyperlane-xyz/cli`) not paths.

### Issue: Patch not applying

**Solution**: Verify patch format matches pnpm expectations. May need to regenerate patch.

### Issue: CI cache not working

**Solution**: Ensure cache paths include `~/.pnpm-store` and use `pnpm-lock.yaml` as key.

### Issue: Scripts fail with pnpm

**Solution**: Some scripts may need `pnpm exec` prefix or workspace filtering adjustments.

## Rollback Plan

If migration fails:

```bash
git checkout main
git branch -D migrate-to-pnpm
# Restore from backup commit if needed
```

## Additional Resources

- [pnpm Documentation](https://pnpm.io/)
- [pnpm Workspaces](https://pnpm.io/workspaces)
- [pnpm Migration Guide](https://pnpm.io/migration)
- [pnpm GitHub Actions](https://github.com/pnpm/action-setup)

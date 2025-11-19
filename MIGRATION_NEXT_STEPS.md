# PNPM Migration - Next Steps

## ✅ Completed
- ✅ Configuration files created (pnpm-workspace.yaml, .npmrc)
- ✅ All package.json scripts updated
- ✅ GitHub Actions workflows updated
- ✅ Dockerfile updated
- ✅ Shell scripts updated
- ✅ Documentation updated
- ✅ Fixed override syntax issues
- ✅ Created pnpm-lock.yaml (via pnpm import)

## 🔧 Next Steps

### Step 1: Fix Workspace Dependencies

Some workspace packages reference each other with version numbers instead of `workspace:*` protocol. Update these to use workspace protocol:

**Files to check and update:**
- `typescript/cli/package.json` - Change `"@hyperlane-xyz/http-registry-server": "19.9.0"` to `"workspace:*"`
- Check other workspace packages for similar issues

**Command to find all workspace dependencies:**
```bash
grep -r "@hyperlane-xyz" typescript/*/package.json solidity/package.json | grep -v "workspace:"
```

**Example fix:**
```json
// Before
"@hyperlane-xyz/http-registry-server": "19.9.0"

// After
"@hyperlane-xyz/http-registry-server": "workspace:*"
```

### Step 2: Test Installation

```bash
# Remove old node_modules
rm -rf node_modules **/node_modules

# Install with pnpm
pnpm install --frozen-lockfile

# If that fails due to workspace issues, try:
pnpm install --no-frozen-lockfile
```

### Step 3: Test Build

```bash
# Test the build
pnpm build

# Test specific workspaces
pnpm -C solidity build
pnpm -C typescript/cli build
```

### Step 4: Test Scripts

```bash
# Test linting
pnpm lint

# Test formatting
pnpm prettier

# Test tests (if possible)
pnpm test
```

### Step 5: Verify Patch Applied

Check that the typechain patch is working:
```bash
# The patch should be automatically applied during install
# Verify by checking if the patched file exists or by running:
pnpm list typechain
```

### Step 6: Update Lockfile (if needed)

If you made changes in Step 1, update the lockfile:
```bash
pnpm install --no-frozen-lockfile
```

### Step 7: Remove Old Yarn Files

**⚠️ Only do this after everything is working!**

```bash
# Remove Yarn-specific files
rm -rf .yarn/
rm yarn.lock
rm .yarnrc.yml

# Verify git status
git status
```

### Step 8: Test CI/CD Locally (Optional)

If you have GitHub Actions CLI or can test workflows:
- Verify the pnpm-cache action works
- Verify pnpm-build-with-cache action works

### Step 9: Commit Changes

```bash
# Review all changes
git diff

# Stage all changes
git add .

# Commit
git commit -m "Migrate from Yarn to pnpm 10.22.0"
```

### Step 10: Push and Test CI

```bash
# Push to a branch
git push origin your-branch-name

# Monitor CI/CD pipelines to ensure they pass
```

## ⚠️ Important: Node Linker Configuration

The migration uses pnpm's **default isolated node_modules** (not hoisted). This provides stricter dependency resolution and prevents phantom dependencies.

**If you encounter dependency errors** (e.g., "Cannot find module" errors), you have two options:

1. **Fix the dependencies** (recommended) - See PR #7401 for examples of fixes when avoiding hoisting
2. **Temporarily use hoisted mode** - Add `node-linker=hoisted` to `.npmrc` if needed for quick fixes

The isolated mode is better long-term as it catches dependency issues early.

## 🔍 Troubleshooting

### If `pnpm install` fails with workspace dependency errors:

1. Find all workspace dependencies:
   ```bash
   grep -r "@hyperlane-xyz" typescript/*/package.json solidity/package.json
   ```

2. Update them to use `workspace:*`:
   ```json
   "@hyperlane-xyz/package-name": "workspace:*"
   ```

3. Re-run `pnpm install`

### If patch doesn't apply:

1. Verify patch file exists: `ls -la patches/typechain@8.3.2.patch`
2. Verify typechain version is pinned: `grep typechain solidity/package.json`
3. Try: `pnpm install --no-frozen-lockfile`

### If build fails:

1. Check for any remaining `yarn` commands in scripts
2. Verify all workspace dependencies are resolved
3. Check for missing dependencies

## 📋 Checklist

- [ ] Fix workspace dependencies to use `workspace:*`
- [ ] Run `pnpm install` successfully
- [ ] Run `pnpm build` successfully
- [ ] Test linting and formatting
- [ ] Verify patch is applied
- [ ] Remove old Yarn files (.yarn/, yarn.lock, .yarnrc.yml)
- [ ] Commit changes
- [ ] Push and verify CI/CD passes

## 🎯 Quick Start Commands

```bash
# 1. Fix workspace dependencies (manual editing required)
# Edit package.json files to use workspace:*

# 2. Install dependencies
pnpm install --no-frozen-lockfile

# 3. Test build
pnpm build

# 4. Remove old files (after testing)
rm -rf .yarn/ yarn.lock .yarnrc.yml

# 5. Commit
git add .
git commit -m "Migrate from Yarn to pnpm 10.22.0"
```

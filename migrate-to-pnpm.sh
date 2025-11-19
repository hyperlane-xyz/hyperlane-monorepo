#!/bin/bash
# migrate-to-pnpm.sh
# Helper script to assist with Yarn to pnpm migration
# WARNING: Review all changes before committing!

set -e

echo "🚀 Starting Yarn to pnpm Migration Helper"
echo "=========================================="
echo ""
echo "⚠️  WARNING: This script will make changes to your repository."
echo "⚠️  Please ensure you're on a migration branch and have committed your work."
echo ""
read -p "Continue? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Migration cancelled."
    exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Check prerequisites
echo ""
echo "📋 Step 1: Checking prerequisites..."
if ! command -v pnpm &> /dev/null; then
    echo -e "${YELLOW}pnpm not found. Installing...${NC}"
    npm install -g pnpm@latest
else
    echo -e "${GREEN}✓ pnpm is installed${NC}"
fi

# Step 2: Create pnpm-workspace.yaml
echo ""
echo "📋 Step 2: Creating pnpm-workspace.yaml..."
if [ -f "pnpm-workspace.yaml" ]; then
    echo -e "${YELLOW}pnpm-workspace.yaml already exists. Skipping...${NC}"
else
    cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'solhint-plugin'
  - 'solidity'
  - 'typescript/*'
  - 'starknet'
EOF
    echo -e "${GREEN}✓ Created pnpm-workspace.yaml${NC}"
fi

# Step 3: Create .npmrc
echo ""
echo "📋 Step 3: Creating .npmrc..."
if [ -f ".npmrc" ]; then
    echo -e "${YELLOW}.npmrc already exists. Backing up to .npmrc.backup...${NC}"
    cp .npmrc .npmrc.backup
fi

cat > .npmrc << 'EOF'
# pnpm configuration
# Equivalent to .yarnrc.yml settings

# Store location (local, not global)
store-dir=~/.pnpm-store

# Use hoisted node_modules (equivalent to nodeLinker: node-modules)
node-linker=hoisted
EOF
echo -e "${GREEN}✓ Created .npmrc${NC}"

# Step 4: Create patches directory
echo ""
echo "📋 Step 4: Setting up patches directory..."
if [ -d "patches" ]; then
    echo -e "${YELLOW}patches directory already exists.${NC}"
else
    mkdir -p patches
    echo -e "${GREEN}✓ Created patches directory${NC}"
fi

# Step 5: Convert yarn patch to pnpm format
echo ""
echo "📋 Step 5: Converting Yarn patches to pnpm format..."
if [ -d ".yarn/patches" ] && [ "$(ls -A .yarn/patches 2>/dev/null)" ]; then
    for patch in .yarn/patches/*.patch; do
        if [ -f "$patch" ]; then
            # Extract package name and version from patch filename
            # Example: typechain-npm-8.3.2-b02e27439e.patch -> typechain@8.3.2.patch
            basename=$(basename "$patch")
            # This is a simplified conversion - may need manual adjustment
            newname=$(echo "$basename" | sed -E 's/^([^-]+)-npm-([0-9]+\.[0-9]+\.[0-9]+)-.*\.patch$/\1@\2.patch/')
            if [ "$newname" != "$basename" ]; then
                cp "$patch" "patches/$newname"
                echo -e "${GREEN}✓ Converted $basename -> $newname${NC}"
            else
                echo -e "${YELLOW}⚠ Could not auto-convert $basename - manual conversion needed${NC}"
            fi
        fi
    done
else
    echo -e "${YELLOW}No Yarn patches found.${NC}"
fi

# Step 6: Convert lockfile
echo ""
echo "📋 Step 6: Converting yarn.lock to pnpm-lock.yaml..."
if [ -f "yarn.lock" ]; then
    if [ -f "pnpm-lock.yaml" ]; then
        echo -e "${YELLOW}pnpm-lock.yaml already exists. Skipping conversion...${NC}"
    else
        echo "Running pnpm import..."
        pnpm import
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓ Lockfile converted successfully${NC}"
        else
            echo -e "${RED}✗ Lockfile conversion failed. You may need to run 'pnpm install' manually.${NC}"
        fi
    fi
else
    echo -e "${YELLOW}No yarn.lock found.${NC}"
fi

# Step 7: Find files that need script updates
echo ""
echo "📋 Step 7: Finding files with yarn commands..."
echo ""
echo "Files containing 'yarn' commands:"
echo "================================"
grep -r "yarn " --include="*.json" --include="*.yml" --include="*.yaml" --include="*.sh" --include="*.md" \
    --exclude-dir=node_modules --exclude-dir=.yarn --exclude-dir=.git \
    --exclude="yarn.lock" --exclude="PNPM_*.md" --exclude="migrate-to-pnpm.sh" \
    . | grep -v "node_modules" | head -20 || echo "No matches found"

echo ""
echo -e "${YELLOW}⚠️  Manual updates needed for:${NC}"
echo "  - package.json files (scripts section)"
echo "  - GitHub Actions workflows (.github/workflows/*.yml)"
echo "  - GitHub Actions (.github/actions/*/action.yml)"
echo "  - Dockerfile"
echo "  - Shell scripts (*.sh)"
echo "  - Documentation (*.md)"
echo ""

# Step 8: Summary
echo ""
echo "📋 Migration Helper Complete!"
echo "=============================="
echo ""
echo -e "${GREEN}✓ Created:${NC}"
echo "  - pnpm-workspace.yaml"
echo "  - .npmrc"
echo "  - patches/ directory"
if [ -f "pnpm-lock.yaml" ]; then
    echo "  - pnpm-lock.yaml (converted)"
fi
echo ""
echo -e "${YELLOW}⚠️  Next steps:${NC}"
echo "  1. Review and update package.json files:"
echo "     - Convert 'resolutions' to 'pnpm.overrides'"
echo "     - Update patch references in 'pnpm.patchedDependencies'"
echo "     - Update all 'yarn' commands in scripts to 'pnpm'"
echo ""
echo "  2. Update GitHub Actions workflows:"
echo "     - Replace yarn cache actions with pnpm equivalents"
echo "     - Update all 'yarn' commands to 'pnpm'"
echo ""
echo "  3. Update Dockerfile:"
echo "     - Replace yarn installation with pnpm"
echo "     - Update COPY commands"
echo ""
echo "  4. Update shell scripts:"
echo "     - Replace 'yarn' commands with 'pnpm'"
echo ""
echo "  5. Test installation:"
echo "     rm -rf node_modules **/node_modules"
echo "     pnpm install"
echo "     pnpm build"
echo ""
echo "  6. Review changes:"
echo "     git diff"
echo ""
echo "  7. Test thoroughly before committing!"
echo ""
echo -e "${RED}⚠️  IMPORTANT: Review all changes before committing!${NC}"
echo ""

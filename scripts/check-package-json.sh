#!/bin/bash

# This script validates:
# 1. All publishable packages have required fields for npm sigstore provenance
# 2. Dockerfile has COPY statements for all workspace package.json files

EXPECTED_REPO="https://github.com/hyperlane-xyz/hyperlane-monorepo"
EXPECTED_LICENSE="Apache-2.0"
ERRORS=0
ROOT="$(pwd)"

# Get all workspace package.json files using pnpm workspaces
# Skip the root workspace (current directory)
# Pipeline: list workspaces as JSON -> extract paths -> filter out root -> convert to relative paths -> append /package.json
PNPM_OUTPUT=$(pnpm list -r --json --depth -1 2>&1)
PNPM_EXIT_CODE=$?

if [ $PNPM_EXIT_CODE -ne 0 ]; then
    echo "ERROR: pnpm list command failed with exit code $PNPM_EXIT_CODE" >&2
    echo "$PNPM_OUTPUT" >&2
    exit 1
fi

PACKAGE_FILES=$(echo "$PNPM_OUTPUT" | jq -r '.[].path' | grep -v "^${ROOT}$" | sed "s|^${ROOT}/||" | sed 's|$|/package.json|')

if [ -z "$PACKAGE_FILES" ]; then
    echo "ERROR: pnpm produced no workspaces. Check pnpm-workspace.yaml configuration." >&2
    exit 1
fi

echo "Checking package.json fields..."

for pkg in $PACKAGE_FILES; do
    # Skip if package is private (not published to npm)
    IS_PRIVATE=$(jq -r '.private // false' "$pkg")
    if [ "$IS_PRIVATE" = "true" ]; then
        continue
    fi

    # Check if package has @hyperlane-xyz scope (published packages)
    NAME=$(jq -r '.name // ""' "$pkg")
    if [[ ! "$NAME" =~ ^@hyperlane-xyz/ ]]; then
        continue
    fi

    # Check repository field - must be a string with exact value
    REPO_TYPE=$(jq -r '.repository | type' "$pkg")
    REPO_VALUE=$(jq -r '.repository // ""' "$pkg")

    if [ "$REPO_TYPE" != "string" ]; then
        echo "ERROR: $pkg has repository as object, must be string format"
        echo "       Required: \"repository\": \"$EXPECTED_REPO\""
        ERRORS=$((ERRORS + 1))
    elif [ -z "$REPO_VALUE" ] || [ "$REPO_VALUE" = "null" ]; then
        echo "ERROR: $pkg is missing 'repository' field"
        echo "       Required for npm sigstore provenance verification"
        ERRORS=$((ERRORS + 1))
    elif [ "$REPO_VALUE" != "$EXPECTED_REPO" ]; then
        echo "ERROR: $pkg has incorrect 'repository' field"
        echo "       Expected: $EXPECTED_REPO"
        echo "       Got: $REPO_VALUE"
        ERRORS=$((ERRORS + 1))
    fi

    # Check license field
    LICENSE_VALUE=$(jq -r '.license // ""' "$pkg")

    if [ -z "$LICENSE_VALUE" ] || [ "$LICENSE_VALUE" = "null" ]; then
        echo "ERROR: $pkg is missing 'license' field"
        echo "       Required: \"license\": \"$EXPECTED_LICENSE\""
        ERRORS=$((ERRORS + 1))
    elif [ "$LICENSE_VALUE" != "$EXPECTED_LICENSE" ]; then
        echo "ERROR: $pkg has incorrect 'license' field"
        echo "       Expected: $EXPECTED_LICENSE"
        echo "       Got: $LICENSE_VALUE"
        ERRORS=$((ERRORS + 1))
    fi
done

echo "Checking Dockerfile COPY statements..."

for pkg in $PACKAGE_FILES; do
    # Check if Dockerfile has a COPY statement for this package.json
    if ! grep -q "COPY $pkg" Dockerfile; then
        echo "ERROR: Dockerfile is missing COPY statement for $pkg"
        echo "       Add: COPY $pkg ./$pkg"
        ERRORS=$((ERRORS + 1))
    fi
done

if [ $ERRORS -gt 0 ]; then
    echo ""
    echo "Found $ERRORS error(s)."
    echo ""
    echo "For package.json issues, all publishable @hyperlane-xyz packages must have:"
    echo "  \"repository\": \"$EXPECTED_REPO\""
    echo "  \"license\": \"$EXPECTED_LICENSE\""
    echo ""
    echo "For Dockerfile issues, add missing COPY statements before 'pnpm install'."
    exit 1
fi

echo "All checks passed."
exit 0

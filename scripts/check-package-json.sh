#!/bin/bash

# This script validates that all publishable packages have the required fields
# for npm's sigstore provenance verification and consistent metadata.

EXPECTED_REPO="https://github.com/hyperlane-xyz/hyperlane-monorepo"
EXPECTED_LICENSE="Apache-2.0"
ERRORS=0

# Find all package.json files in workspaces (typescript/*, solidity, starknet, solhint-plugin)
PACKAGE_FILES=$(find typescript solidity starknet solhint-plugin -maxdepth 2 -name "package.json" -type f 2>/dev/null)

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

if [ $ERRORS -gt 0 ]; then
    echo ""
    echo "Found $ERRORS error(s) in package.json fields."
    echo "All publishable @hyperlane-xyz packages must have:"
    echo "  \"repository\": \"$EXPECTED_REPO\""
    echo "  \"license\": \"$EXPECTED_LICENSE\""
    exit 1
fi

echo "All publishable packages have correct repository and license fields."
exit 0

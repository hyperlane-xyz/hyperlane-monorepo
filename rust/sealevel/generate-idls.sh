#!/bin/bash
set -e

# Script to generate IDL files for all Hyperlane Sealevel programs using Shank

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDL_DIR="$SCRIPT_DIR/programs/idl"

# Ensure IDL directory exists
mkdir -p "$IDL_DIR"

echo "Generating IDLs for Hyperlane Sealevel programs..."
echo "Output directory: $IDL_DIR"
echo ""

# Tier 0: Library Crates (for IDL imports)
echo "=== Tier 0: Library Crates ==="

echo "Generating IDL for hyperlane-core..."
cd "$SCRIPT_DIR/../main/hyperlane-core"
shank idl -p hyperlane-core

echo "Generating IDL for hyperlane-sealevel-connection-client..."
cd "$SCRIPT_DIR/libraries/hyperlane-sealevel-connection-client"
shank idl -p hyperlane-sealevel-connection-client

echo "Generating IDL for hyperlane-sealevel-token-lib..."
cd "$SCRIPT_DIR/libraries/hyperlane-sealevel-token"
shank idl -p hyperlane-sealevel-token-lib

echo ""
echo "=== Tier 1: Core Infrastructure ==="

echo "Generating IDL for mailbox..."
cd "$SCRIPT_DIR/programs/mailbox"
shank idl -p HyperlaneMailbox11111111111111111111111111111 -o "$IDL_DIR"

echo "Generating IDL for hyperlane-sealevel-igp..."
cd "$SCRIPT_DIR/programs/hyperlane-sealevel-igp"
shank idl -p HyperlaneIGP1111111111111111111111111111111111 -o "$IDL_DIR"

echo "Generating IDL for validator-announce..."
cd "$SCRIPT_DIR/programs/validator-announce"
shank idl -p HyperlaneValidatorAnnounce1111111111111111111 -o "$IDL_DIR"

# Tier 2: Application Layer
echo ""
echo "=== Tier 2: Application Layer ==="

echo "Generating IDL for helloworld..."
cd "$SCRIPT_DIR/programs/helloworld"
shank idl -p HyperlaneHelloWorld1111111111111111111111111 -o "$IDL_DIR"

echo "Generating IDL for hyperlane-sealevel-token..."
cd "$SCRIPT_DIR/programs/hyperlane-sealevel-token"
shank idl -p HyperlaneToken111111111111111111111111111111 -o "$IDL_DIR"

echo "Generating IDL for hyperlane-sealevel-token-native..."
cd "$SCRIPT_DIR/programs/hyperlane-sealevel-token-native"
shank idl -p HyperlaneTokenNative111111111111111111111111 -o "$IDL_DIR"

echo "Generating IDL for hyperlane-sealevel-token-collateral..."
cd "$SCRIPT_DIR/programs/hyperlane-sealevel-token-collateral"
shank idl -p HyperlaneTokenCollateral1111111111111111111 -o "$IDL_DIR"

# Tier 3: ISM Programs
echo ""
echo "=== Tier 3: ISM Programs ==="

echo "Generating IDL for multisig-ism-message-id..."
cd "$SCRIPT_DIR/programs/ism/multisig-ism-message-id"
shank idl -p HyperlaneMultisigIsm1111111111111111111111111 -o "$IDL_DIR"

echo "Generating IDL for test-ism..."
cd "$SCRIPT_DIR/programs/ism/test-ism"
shank idl -p HyperlaneTestIsm1111111111111111111111111111 -o "$IDL_DIR"

echo ""
echo "✅ All IDLs generated successfully in $IDL_DIR"
echo ""
echo "Generated files:"
ls -1 "$IDL_DIR"/*.json 2>/dev/null | xargs -n1 basename

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

# Tier 1: Core Infrastructure
echo "=== Tier 1: Core Infrastructure ==="

echo "Generating IDL for mailbox..."
cd "$SCRIPT_DIR/programs/mailbox"
shank idl -p HyperlaneMailbox11111111111111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_mailbox.json" "$IDL_DIR/mailbox.json.tmp"
mv "$IDL_DIR/mailbox.json.tmp" "$IDL_DIR/hyperlane_sealevel_mailbox.json"

echo "Generating IDL for hyperlane-sealevel-igp..."
cd "$SCRIPT_DIR/programs/hyperlane-sealevel-igp"
shank idl -p HyperlaneIGP1111111111111111111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_igp.json" "$IDL_DIR/igp.json.tmp"
mv "$IDL_DIR/igp.json.tmp" "$IDL_DIR/hyperlane_sealevel_igp.json"

echo "Generating IDL for validator-announce..."
cd "$SCRIPT_DIR/programs/validator-announce"
shank idl -p HyperlaneValidatorAnnounce1111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_validator_announce.json" "$IDL_DIR/validator.json.tmp"
mv "$IDL_DIR/validator.json.tmp" "$IDL_DIR/hyperlane_sealevel_validator_announce.json"

# Tier 2: Application Layer
echo ""
echo "=== Tier 2: Application Layer ==="

echo "Generating IDL for helloworld..."
cd "$SCRIPT_DIR/programs/helloworld"
shank idl -p HyperlaneHelloWorld1111111111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_hello_world.json" "$IDL_DIR/hello.json.tmp"
mv "$IDL_DIR/hello.json.tmp" "$IDL_DIR/hyperlane_sealevel_hello_world.json"

echo "Generating IDL for hyperlane-sealevel-token..."
cd "$SCRIPT_DIR/programs/hyperlane-sealevel-token"
shank idl -p HyperlaneToken111111111111111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_token.json" "$IDL_DIR/token.json.tmp"
mv "$IDL_DIR/token.json.tmp" "$IDL_DIR/hyperlane_sealevel_token.json"

echo "Generating IDL for hyperlane-sealevel-token-native..."
cd "$SCRIPT_DIR/programs/hyperlane-sealevel-token-native"
shank idl -p HyperlaneTokenNative111111111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_token_native.json" "$IDL_DIR/token_native.json.tmp"
mv "$IDL_DIR/token_native.json.tmp" "$IDL_DIR/hyperlane_sealevel_token_native.json"

echo "Generating IDL for hyperlane-sealevel-token-collateral..."
cd "$SCRIPT_DIR/programs/hyperlane-sealevel-token-collateral"
shank idl -p HyperlaneTokenCollateral1111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_token_collateral.json" "$IDL_DIR/token_collateral.json.tmp"
mv "$IDL_DIR/token_collateral.json.tmp" "$IDL_DIR/hyperlane_sealevel_token_collateral.json"

# Tier 3: ISM Programs
echo ""
echo "=== Tier 3: ISM Programs ==="

echo "Generating IDL for multisig-ism-message-id..."
cd "$SCRIPT_DIR/programs/ism/multisig-ism-message-id"
shank idl -p HyperlaneMultisigIsm1111111111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_multisig_ism_message_id.json" "$IDL_DIR/multisig.json.tmp"
mv "$IDL_DIR/multisig.json.tmp" "$IDL_DIR/hyperlane_sealevel_multisig_ism_message_id.json"

echo "Generating IDL for test-ism..."
cd "$SCRIPT_DIR/programs/ism/test-ism"
shank idl -p HyperlaneTestIsm1111111111111111111111111111 -o "$IDL_DIR"
mv "$IDL_DIR/hyperlane_sealevel_test_ism.json" "$IDL_DIR/test_ism.json.tmp"
mv "$IDL_DIR/test_ism.json.tmp" "$IDL_DIR/hyperlane_sealevel_test_ism.json"

echo ""
echo "✅ All IDLs generated successfully in $IDL_DIR"
echo ""
echo "Generated files:"
ls -1 "$IDL_DIR"/*.json 2>/dev/null | xargs -n1 basename

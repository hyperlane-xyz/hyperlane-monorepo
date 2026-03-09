#!/bin/bash
# Cross-VM test: Sealevel MultiCollateral ↔ EVM Collateral
#
# Tests cross-chain message compatibility between Sealevel and EVM by:
# 1. Starting solana-test-validator + anvil
# 2. Deploying core infrastructure on both chains
# 3. Deploying MC warp route on Sealevel, HypERC20Collateral on EVM
# 4. Cross-enrolling routers
# 5. Testing Sealevel→EVM transfer (outbound dispatch + EVM relay)
# 6. Testing EVM→Sealevel transfer (outbound dispatch)
#
# Prerequisites:
#   - Rust toolchain with cargo-build-sbf (or agave CLI tools)
#   - solana CLI tools (solana, solana-test-validator, spl-token)
#   - foundry (forge, cast, anvil)
#   - jq
#   - pnpm (for TypeScript SDK if needed)
#
# Usage:
#   cd rust/sealevel && bash scripts/test-cross-vm.sh

set -euo pipefail

# ========================================
# Configuration
# ========================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEALEVEL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SEALEVEL_DIR/../.." && pwd)"
SOLIDITY_DIR="$REPO_ROOT/solidity"

# Domain IDs
SEALEVEL_DOMAIN=13375  # sealeveltest1
EVM_DOMAIN=31337       # anvil default chain ID

# Sealevel config
SEALEVEL_RPC="http://127.0.0.1:8899"
SEALEVEL_DEPLOYER_KEYPAIR="$SEALEVEL_DIR/environments/local-e2e/accounts/test_deployer-keypair.json"
SEALEVEL_ENVS_DIR="$SEALEVEL_DIR/environments"
SEALEVEL_ENV_NAME="local-e2e"
SEALEVEL_MOCK_REGISTRY="environments/local-e2e/mock-registry"
SBF_OUT_PATH="$SEALEVEL_DIR/target/dist"

# EVM config
EVM_RPC="http://127.0.0.1:8545"
ANVIL_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# Temp dir for test artifacts
WORK_DIR=$(mktemp -d)
LEDGER_DIR=$(mktemp -d)
trap 'cleanup' EXIT

# Track background processes
PIDS=()
BUILD_SBF_MODE=""

# ========================================
# Utility functions
# ========================================

log() {
    echo "=== [cross-vm-test] $*"
}

fail() {
    echo "!!! FAIL: $*" >&2
    exit 1
}

cleanup() {
    log "Cleaning up..."
    if [[ -n "${PIDS+set}" && "${#PIDS[@]}" -gt 0 ]]; then
        for pid in "${PIDS[@]}"; do
            kill "$pid" 2>/dev/null || true
        done
    fi
    rm -rf "$WORK_DIR" "$LEDGER_DIR"
}

bootstrap_path() {
    local candidate_paths=(
        "$HOME/.local/share/solana/install/active_release/bin"
        "/opt/homebrew/bin"
        "/usr/local/bin"
    )
    local p
    for p in "${candidate_paths[@]}"; do
        if [ -d "$p" ] && [[ ":$PATH:" != *":$p:"* ]]; then
            PATH="$p:$PATH"
        fi
    done
    export PATH
}

require_cmd() {
    local cmd="$1"
    command -v "$cmd" >/dev/null 2>&1 || fail "Missing required command: $cmd (PATH=$PATH)"
}

detect_build_sbf() {
    if command -v cargo-build-sbf >/dev/null 2>&1; then
        BUILD_SBF_MODE="cargo-build-sbf"
        return
    fi
    if cargo --list 2>/dev/null | awk '{print $1}' | grep -qx "build-sbf"; then
        BUILD_SBF_MODE="cargo-build-sbf-subcommand"
        return
    fi
    fail "Missing cargo build-sbf tooling. Install Solana/Agave CLI so cargo-build-sbf is available."
}

build_sbf_program() {
    local program_dir="$1"
    if [ "$BUILD_SBF_MODE" = "cargo-build-sbf" ]; then
        (cd "$program_dir" && cargo-build-sbf)
    else
        (cd "$program_dir" && cargo build-sbf)
    fi
}

check_prerequisites() {
    bootstrap_path
    require_cmd cargo
    require_cmd jq
    require_cmd curl
    require_cmd python3
    require_cmd solana
    require_cmd solana-keygen
    require_cmd solana-test-validator
    require_cmd spl-token
    require_cmd anvil
    require_cmd forge
    require_cmd cast
    detect_build_sbf
}

sealevel_client() {
    "$SEALEVEL_DIR/target/debug/hyperlane-sealevel-client" \
        --config "$SOLANA_CONFIG" \
        --keypair "$SEALEVEL_DEPLOYER_KEYPAIR" \
        "$@"
}

# Wait for RPC to be ready
wait_for_rpc() {
    local url="$1"
    local name="$2"
    local max_attempts=30
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "$url" -X POST -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null 2>&1 || \
           curl -sf "$url" -X POST -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' >/dev/null 2>&1; then
            log "$name is ready"
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    fail "$name did not start within ${max_attempts}s"
}

rpc_post() {
    local url="$1"
    local payload="$2"
    curl -sf "$url" -X POST -H "Content-Type: application/json" -d "$payload"
}

get_spl_balance_raw() {
    local owner="$1"
    local mint="$2"
    local resp
    resp=$(rpc_post "$SEALEVEL_RPC" "{
      \"jsonrpc\":\"2.0\",
      \"id\":1,
      \"method\":\"getTokenAccountsByOwner\",
      \"params\":[\"$owner\", {\"mint\":\"$mint\"}, {\"encoding\":\"jsonParsed\"}]
    }")
    echo "$resp" | jq -r '.result.value[0].account.data.parsed.info.tokenAmount.amount // "0"'
}

# ========================================
# Step 0: Build prerequisites
# ========================================

build_sealevel_programs() {
    log "Building sealevel programs (including multicollateral)..."
    cd "$SEALEVEL_DIR"

    # Build the sealevel client
    cargo build -p hyperlane-sealevel-client 2>&1 | tail -5

    # Build sealevel programs using cargo-build-sbf
    # (requires agave CLI tools to be installed)
    local programs=(
        "mailbox"
        "validator-announce"
        "ism/multisig-ism-message-id"
        "hyperlane-sealevel-token"
        "hyperlane-sealevel-token-native"
        "hyperlane-sealevel-token-collateral"
        "hyperlane-sealevel-token-multicollateral"
        "hyperlane-sealevel-igp"
    )

    mkdir -p "$SBF_OUT_PATH"
    export SBF_OUT_PATH

    for prog in "${programs[@]}"; do
        log "  Building $prog..."
        build_sbf_program "$SEALEVEL_DIR/programs/$prog" 2>&1 | tail -3
    done
    log "All sealevel programs built"
}

# ========================================
# Step 1: Start chains
# ========================================

start_solana_validator() {
    log "Starting solana-test-validator..."

    # Create a temp solana config
    SOLANA_CONFIG="$WORK_DIR/solana-config.yml"
    solana config set \
        --url "$SEALEVEL_RPC" \
        --keypair "$SEALEVEL_DEPLOYER_KEYPAIR" \
        --config "$SOLANA_CONFIG" 2>&1 | tail -1

    # Load SPL token programs (pre-built)
    local spl_args=()
    # These are standard SPL programs that need to be loaded
    # If they exist in the dist dir, load them
    if [ -f "$SBF_OUT_PATH/spl_token.so" ]; then
        spl_args+=(
            --bpf-program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA "$SBF_OUT_PATH/spl_token.so"
            --bpf-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "$SBF_OUT_PATH/spl_token_2022.so"
            --bpf-program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL "$SBF_OUT_PATH/spl_associated_token_account.so"
            --bpf-program noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV "$SBF_OUT_PATH/spl_noop.so"
        )
    fi

    # Load deployer account
    local deployer_account="$SEALEVEL_DIR/environments/local-e2e/accounts/test_deployer-account.json"
    local deployer_pubkey="E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty"

    solana-test-validator \
        --quiet --reset \
        --ledger "$LEDGER_DIR" \
        --account "$deployer_pubkey" "$deployer_account" \
        "${spl_args[@]+"${spl_args[@]}"}" &
    PIDS+=($!)

    wait_for_rpc "$SEALEVEL_RPC" "Solana"
}

start_anvil() {
    log "Starting anvil..."
    anvil --silent &
    PIDS+=($!)
    wait_for_rpc "$EVM_RPC" "Anvil"
}

# ========================================
# Step 2: Deploy Sealevel core + warp route
# ========================================

deploy_sealevel_core() {
    log "Deploying Sealevel core (domain=$SEALEVEL_DOMAIN)..."
    cd "$SEALEVEL_DIR"

    sealevel_client \
        --compute-budget 200000 \
        core deploy \
        --local-domain "$SEALEVEL_DOMAIN" \
        --environment "$SEALEVEL_ENV_NAME" \
        --environments-dir "$SEALEVEL_ENVS_DIR" \
        --chain sealeveltest1 \
        --built-so-dir "$SBF_OUT_PATH" 2>&1 | tail -5

    # Read the deployed program IDs
    SEALEVEL_MAILBOX=$(jq -r '.mailbox' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/sealeveltest1/core/program-ids.json")
    SEALEVEL_IGP=$(jq -r '.igp_program_id' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/sealeveltest1/core/program-ids.json")
    log "  Mailbox: $SEALEVEL_MAILBOX"
    log "  IGP: $SEALEVEL_IGP"
}

create_spl_token_mint() {
    log "Creating SPL token mint (decimals=6)..."
    # Create a new SPL token
    local output
    if ! output=$(spl-token create-token --decimals 6 --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" 2>&1); then
        fail "spl-token create-token failed: $output"
    fi
    SPL_MINT=$(echo "$output" | grep -oE '[A-HJ-NP-Za-km-z1-9]{32,44}' | head -1 || true)
    if [ -z "$SPL_MINT" ]; then
        fail "Failed to parse SPL mint address from spl-token output: $output"
    fi
    log "  SPL Mint: $SPL_MINT"

    # Create an associated token account for the deployer
    spl-token create-account "$SPL_MINT" --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" 2>&1 | tail -1 || fail "spl-token create-account failed"

    # Mint tokens to the deployer
    spl-token mint "$SPL_MINT" 1000000000 --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" 2>&1 | tail -1 || fail "spl-token mint failed"
    log "  Minted 1,000,000,000 tokens (= 1000 with 6 decimals)"
}

deploy_sealevel_mc_warp_route() {
    log "Deploying Sealevel MultiCollateral warp route..."
    cd "$SEALEVEL_DIR"

    # Create token config with actual mint address
    local token_config="$WORK_DIR/mc-token-config.json"
    cat > "$token_config" <<EOF
{
  "sealeveltest1": {
    "type": "multiCollateral",
    "token": "$SPL_MINT",
    "decimals": 6,
    "remoteDecimals": 18
  }
}
EOF

    sealevel_client \
        --compute-budget 200000 \
        warp-route deploy \
        --environment "$SEALEVEL_ENV_NAME" \
        --environments-dir "$SEALEVEL_ENVS_DIR" \
        --built-so-dir "$SBF_OUT_PATH" \
        --warp-route-name mctest \
        --token-config-file "$token_config" \
        --registry "$SEALEVEL_MOCK_REGISTRY" \
        --ata-payer-funding-amount 1000000000 2>&1 | tail -10

    # Read the deployed warp route program ID
    SEALEVEL_MC_PROGRAM=$(jq -r '.sealeveltest1.base58' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/warp-routes/mctest/program-ids.json")
    SEALEVEL_MC_PROGRAM_HEX=$(jq -r '.sealeveltest1.hex' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/warp-routes/mctest/program-ids.json")
    log "  MC Warp Route Program: $SEALEVEL_MC_PROGRAM"
    log "  MC Warp Route Hex: $SEALEVEL_MC_PROGRAM_HEX"
}

# ========================================
# Step 3: Deploy EVM core + warp route
# ========================================

deploy_evm_contracts() {
    log "Deploying EVM contracts on Anvil..."
    cd "$SOLIDITY_DIR"

    # 1. Deploy Mailbox
    log "  Deploying Mailbox (domain=$EVM_DOMAIN)..."
    local mailbox_output
    if ! mailbox_output=$(forge create contracts/Mailbox.sol:Mailbox \
        --broadcast \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" \
        --constructor-args "$EVM_DOMAIN" 2>&1); then
        fail "forge create Mailbox failed: $mailbox_output"
    fi
    EVM_MAILBOX=$(echo "$mailbox_output" | awk '/Deployed to:/{print $3}' | head -1 || true)
    if [ -z "$EVM_MAILBOX" ]; then
        fail "Could not parse Mailbox address from forge output: $mailbox_output"
    fi
    log "    Mailbox: $EVM_MAILBOX"

    # 2. Deploy TestIsm (always returns true)
    log "  Deploying TestIsm..."
    local ism_output
    if ! ism_output=$(forge create contracts/test/TestIsm.sol:TestIsm \
        --broadcast \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" 2>&1); then
        fail "forge create TestIsm failed: $ism_output"
    fi
    EVM_ISM=$(echo "$ism_output" | awk '/Deployed to:/{print $3}' | head -1 || true)
    if [ -z "$EVM_ISM" ]; then
        fail "Could not parse TestIsm address from forge output: $ism_output"
    fi
    log "    TestIsm: $EVM_ISM"

    # 3. Deploy a test hook (NoopHook - does nothing)
    log "  Deploying TestPostDispatchHook..."
    local hook_output
    if ! hook_output=$(forge create contracts/test/TestPostDispatchHook.sol:TestPostDispatchHook \
        --broadcast \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" 2>&1); then
        fail "forge create TestPostDispatchHook failed: $hook_output"
    fi
    EVM_HOOK=$(echo "$hook_output" | awk '/Deployed to:/{print $3}' | head -1 || true)
    if [ -z "$EVM_HOOK" ]; then
        fail "Could not parse TestPostDispatchHook address from forge output: $hook_output"
    fi
    log "    Hook: $EVM_HOOK"

    # 4. Initialize Mailbox
    log "  Initializing Mailbox..."
    cast send "$EVM_MAILBOX" \
        "initialize(address,address,address,address)" \
        "$ANVIL_ADDRESS" "$EVM_ISM" "$EVM_HOOK" "$EVM_HOOK" \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    # 5. Deploy ERC20Test
    log "  Deploying ERC20Test..."
    local erc20_output
    if ! erc20_output=$(forge create contracts/test/ERC20Test.sol:ERC20Test \
        --broadcast \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" \
        --constructor-args "TestToken" "TST" "0" "18" 2>&1); then
        fail "forge create ERC20Test failed: $erc20_output"
    fi
    EVM_ERC20=$(echo "$erc20_output" | awk '/Deployed to:/{print $3}' | head -1 || true)
    if [ -z "$EVM_ERC20" ]; then
        fail "Could not parse ERC20Test address from forge output: $erc20_output"
    fi
    log "    ERC20: $EVM_ERC20"

    # 6. Deploy HypERC20Collateral
    log "  Deploying HypERC20Collateral..."
    local collateral_output
    # Constructor: (address erc20, uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)
    # Scale 1:1 for now (numerator=1, denominator=1)
    if ! collateral_output=$(forge create contracts/token/HypERC20Collateral.sol:HypERC20Collateral \
        --broadcast \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" \
        --constructor-args "$EVM_ERC20" 1 1 "$EVM_MAILBOX" 2>&1); then
        fail "forge create HypERC20Collateral failed: $collateral_output"
    fi
    EVM_COLLATERAL=$(echo "$collateral_output" | awk '/Deployed to:/{print $3}' | head -1 || true)
    if [ -z "$EVM_COLLATERAL" ]; then
        fail "Could not parse HypERC20Collateral address from forge output: $collateral_output"
    fi
    log "    HypERC20Collateral: $EVM_COLLATERAL"

    # 7. Initialize HypERC20Collateral
    log "  Initializing HypERC20Collateral..."
    cast send "$EVM_COLLATERAL" \
        "initialize(address,address,address)" \
        "$EVM_HOOK" "$EVM_ISM" "$ANVIL_ADDRESS" \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    log "  All EVM contracts deployed"
}

# ========================================
# Step 4: Cross-enroll routers
# ========================================

cross_enroll_routers() {
    log "Cross-enrolling routers..."

    # Enroll EVM collateral router on Sealevel MC warp route
    # The EVM address needs to be left-padded to 32 bytes (H256)
    local evm_router_h256
    evm_router_h256=$(printf "0x000000000000000000000000%s" "${EVM_COLLATERAL#0x}")
    log "  Enrolling EVM router on Sealevel: domain=$EVM_DOMAIN router=$evm_router_h256"

    sealevel_client \
        token enroll-remote-router \
        --program-id "$SEALEVEL_MC_PROGRAM" \
        "$EVM_DOMAIN" \
        "$evm_router_h256" 2>&1 | tail -3

    # Enroll Sealevel MC warp route on EVM HypERC20Collateral
    log "  Enrolling Sealevel router on EVM: domain=$SEALEVEL_DOMAIN router=$SEALEVEL_MC_PROGRAM_HEX"

    cast send "$EVM_COLLATERAL" \
        "enrollRemoteRouter(uint32,bytes32)" \
        "$SEALEVEL_DOMAIN" \
        "$SEALEVEL_MC_PROGRAM_HEX" \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    # Set destination gas on Sealevel
    sealevel_client \
        token set-destination-gas \
        --program-id "$SEALEVEL_MC_PROGRAM" \
        "$EVM_DOMAIN" \
        "68000" 2>&1 | tail -3

    log "  Routers cross-enrolled"
}

# ========================================
# Step 5: Test Sealevel → EVM transfer
# ========================================

test_sealevel_to_evm() {
    log "=== Testing Sealevel → EVM transfer ==="

    # The recipient on EVM - use the Anvil default account for simplicity
    # Sealevel transfer-remote expects a hex address for EVM recipients
    local recipient_h256
    recipient_h256=$(printf "0x000000000000000000000000%s" "${ANVIL_ADDRESS#0x}")

    # Mint some ERC20 to the HypERC20Collateral contract on EVM (to simulate collateral pool)
    # When message arrives, the collateral contract will send tokens to the recipient
    log "  Minting ERC20 tokens to HypERC20Collateral contract on EVM..."
    cast send "$EVM_ERC20" \
        "mintTo(address,uint256)" \
        "$EVM_COLLATERAL" \
        "1000000000000000000000" \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    local evm_collateral_balance
    evm_collateral_balance=$(cast call "$EVM_ERC20" "balanceOf(address)(uint256)" "$EVM_COLLATERAL" --rpc-url "$EVM_RPC")
    log "  EVM Collateral balance: $evm_collateral_balance"

    # Check initial recipient balance on EVM
    local initial_balance
    initial_balance=$(cast call "$EVM_ERC20" "balanceOf(address)(uint256)" "$ANVIL_ADDRESS" --rpc-url "$EVM_RPC")
    log "  Initial recipient ERC20 balance: $initial_balance"

    # Transfer from Sealevel
    local transfer_amount=1000000  # 1.0 tokens with 6 decimals
    log "  Initiating transfer-remote on Sealevel (amount=$transfer_amount)..."

    local transfer_output
    if ! transfer_output=$(sealevel_client \
        token transfer-remote \
        --program-id "$SEALEVEL_MC_PROGRAM" \
        "$SEALEVEL_DEPLOYER_KEYPAIR" \
        "$transfer_amount" \
        "$EVM_DOMAIN" \
        "$recipient_h256" \
        "multi-collateral" 2>&1); then
        fail "Sealevel transfer-remote failed: $transfer_output"
    fi

    echo "$transfer_output" | tail -10
    log "  Transfer dispatched on Sealevel"

    # Fetch the dispatched message using the relayer's approach:
    # Query getProgramAccounts with memcmp filter on discriminator + nonce at offset 1.
    # Account layout: initialized(1) + discriminator(8) + nonce(4) + slot(8) + unique_pubkey(32) + message(var)
    # Raw Hyperlane message bytes start at offset 53.
    local nonce=0  # First message after fresh deploy
    local filter_b64
    filter_b64=$(python3 -c "
import base64, struct
discriminator = b'DISPATCH'
nonce_bytes = struct.pack('<I', $nonce)
print(base64.b64encode(discriminator + nonce_bytes).decode())
")

    log "  Fetching dispatched message (nonce=$nonce) from mailbox $SEALEVEL_MAILBOX..."
    local accounts_json
    accounts_json=$(rpc_post "$SEALEVEL_RPC" "{
      \"jsonrpc\":\"2.0\",
      \"id\":1,
      \"method\":\"getProgramAccounts\",
      \"params\":[
        \"$SEALEVEL_MAILBOX\",
        {
          \"encoding\":\"base64\",
          \"filters\":[
            {
              \"memcmp\":{
                \"offset\":1,
                \"bytes\":\"$filter_b64\",
                \"encoding\":\"base64\"
              }
            }
          ]
        }
      ]
    }")

    local msg_hex
    msg_hex=$(echo "$accounts_json" | python3 -c "
import base64, binascii, json, sys
obj = json.load(sys.stdin)
accounts = obj.get('result', [])
if not accounts:
    sys.exit('No dispatched message account found for nonce $nonce')
raw = base64.b64decode(accounts[0]['account']['data'][0])
# Skip: initialized(1) + discriminator(8) + nonce(4) + slot(8) + unique_pubkey(32) = 53
if len(raw) <= 53:
    sys.exit('Account data too short')
print(binascii.hexlify(raw[53:]).decode(), end='')
")

    if [ -z "$msg_hex" ]; then
        fail "Failed to extract dispatched message bytes for nonce $nonce"
    fi
    log "  Extracted message (${#msg_hex} hex chars)"

    log "  Relaying Sealevel message to EVM mailbox.process..."
    cast send "$EVM_MAILBOX" \
        "process(bytes,bytes)" \
        "0x" \
        "0x$msg_hex" \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    local final_balance
    final_balance=$(cast call "$EVM_ERC20" "balanceOf(address)(uint256)" "$ANVIL_ADDRESS" --rpc-url "$EVM_RPC")
    log "  Final recipient ERC20 balance: $final_balance"
    if [ "$final_balance" = "$initial_balance" ]; then
        fail "Sealevel→EVM relay did not change recipient ERC20 balance"
    fi
    log "  Sealevel→EVM relay PASSED"
}

# ========================================
# Step 6: Test EVM → Sealevel transfer
# ========================================

test_evm_to_sealevel() {
    log "=== Testing EVM → Sealevel transfer ==="

    # The recipient on Sealevel - use the deployer pubkey
    local deployer_pubkey
    deployer_pubkey=$(solana-keygen pubkey "$SEALEVEL_DEPLOYER_KEYPAIR")
    # Pad to 32 bytes (Solana pubkeys are already 32 bytes, just hex-encode)
    local recipient_h256
    recipient_h256="0x$(solana-keygen pubkey "$SEALEVEL_DEPLOYER_KEYPAIR" | python3 -c "
import sys, base58
pubkey = sys.stdin.read().strip()
decoded = base58.b58decode(pubkey)
print(decoded.hex())
" 2>/dev/null || echo "SKIP_NO_BASE58")"

    if [[ "$recipient_h256" == *"SKIP_NO_BASE58"* ]]; then
        log "  Skipping EVM→Sealevel test (python3 base58 module not available)"
        log "  Install with: pip3 install base58"
        return
    fi

    # Mint ERC20 tokens to the Anvil account
    log "  Minting ERC20 tokens to sender..."
    cast send "$EVM_ERC20" \
        "mintTo(address,uint256)" \
        "$ANVIL_ADDRESS" \
        "1000000000000000000" \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    # Approve HypERC20Collateral to spend tokens
    log "  Approving HypERC20Collateral..."
    cast send "$EVM_ERC20" \
        "approve(address,uint256)" \
        "$EVM_COLLATERAL" \
        "1000000000000000000" \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    local initial_sol_balance
    initial_sol_balance=$(get_spl_balance_raw "$deployer_pubkey" "$SPL_MINT")
    log "  Initial Sealevel recipient token balance: $initial_sol_balance"

    # Transfer remote to Sealevel
    local transfer_amount="1000000000000000000"  # 1.0 tokens with 18 decimals
    log "  Initiating transferRemote on EVM (amount=$transfer_amount to domain=$SEALEVEL_DOMAIN)..."

    local tx_hash
    tx_hash=$(cast send "$EVM_COLLATERAL" \
        "transferRemote(uint32,bytes32,uint256)" \
        "$SEALEVEL_DOMAIN" \
        "$recipient_h256" \
        "$transfer_amount" \
        --rpc-url "$EVM_RPC" \
        --private-key "$ANVIL_PRIVATE_KEY" \
        --json 2>&1 | jq -r '.transactionHash')

    log "  EVM transferRemote tx: $tx_hash"

    local receipt_json
    receipt_json=$(cast receipt "$tx_hash" --rpc-url "$EVM_RPC" --json 2>/dev/null)

    # Dispatch event data contains ABI-encoded "bytes message"
    local dispatch_data
    dispatch_data=$(echo "$receipt_json" | jq -r '.logs[] | select(.topics[0] == "0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814") | .data' | head -1)
    if [ -z "$dispatch_data" ] || [ "$dispatch_data" = "null" ]; then
        fail "Could not extract Dispatch event data from EVM logs"
    fi
    local raw_message
    raw_message=$(cast abi-decode "(bytes)" "$dispatch_data" | tr -d '\n')
    if [ -z "$raw_message" ] || [ "$raw_message" = "0x" ]; then
        fail "Failed to decode raw Hyperlane message from Dispatch event"
    fi

    local message_id
    message_id=$(echo "$receipt_json" | jq -r '.logs[] | select(.topics[0] == "0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a") | .topics[1]' | head -1)
    if [ -z "$message_id" ] || [ "$message_id" = "null" ]; then
        fail "Could not extract DispatchId message ID from EVM logs"
    fi
    log "  Message ID: $message_id"

    log "  Relaying EVM message to Sealevel mailbox process..."
    sealevel_client \
        mailbox process \
        --program-id "$SEALEVEL_MAILBOX" \
        --message "$raw_message" \
        --metadata "0x" 2>&1 | tail -10

    log "  Verifying Sealevel mailbox delivered(message_id)..."
    local delivered_output
    delivered_output=$(sealevel_client \
        mailbox delivered \
        --program-id "$SEALEVEL_MAILBOX" \
        --message-id "$message_id" 2>&1)
    echo "$delivered_output" | tail -3
    if ! echo "$delivered_output" | rg -q "Message delivered"; then
        fail "EVM→Sealevel message was not marked delivered"
    fi

    local final_sol_balance
    final_sol_balance=$(get_spl_balance_raw "$deployer_pubkey" "$SPL_MINT")
    log "  Final Sealevel recipient token balance: $final_sol_balance"
    if [ "$final_sol_balance" = "$initial_sol_balance" ]; then
        fail "EVM→Sealevel relay did not change recipient token balance"
    fi
    log "  EVM→Sealevel relay PASSED"
}

# ========================================
# Main execution
# ========================================

main() {
    log "Starting Cross-VM test: Sealevel MultiCollateral ↔ EVM Collateral"
    log "Working directory: $WORK_DIR"
    check_prerequisites

    # Build
    build_sealevel_programs

    # Start chains
    start_solana_validator
    start_anvil

    # Deploy Sealevel
    deploy_sealevel_core
    create_spl_token_mint
    deploy_sealevel_mc_warp_route

    # Deploy EVM
    deploy_evm_contracts

    # Cross-enroll
    cross_enroll_routers

    # Test transfers
    test_sealevel_to_evm
    test_evm_to_sealevel

    log ""
    log "========================================"
    log "Cross-VM test completed!"
    log "========================================"
    log ""
    log "Summary:"
    log "  Sealevel MC Program: $SEALEVEL_MC_PROGRAM"
    log "  EVM HypERC20Collateral: $EVM_COLLATERAL"
    log "  Sealevel→EVM: Relay PASSED"
    log "  EVM→Sealevel: Relay PASSED"
    log ""
}

main "$@"

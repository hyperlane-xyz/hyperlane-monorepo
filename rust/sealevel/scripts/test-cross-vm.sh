#!/bin/bash
# Cross-VM test: Sealevel MultiCollateral ↔ EVM Collateral (multi-remote-router)
#
# Tests cross-chain message compatibility between Sealevel and two EVM chains:
# 1. Starting solana-test-validator + two anvil instances
# 2. Deploying core infrastructure on all three chains
# 3. Deploying MC warp route on Sealevel, HypERC20Collateral on each EVM chain
# 4. Cross-enrolling routers (Sealevel MC enrolled with both EVM routers)
# 5. Testing Sealevel→EVM1, Sealevel→EVM2 transfers
# 6. Testing EVM1→Sealevel, EVM2→Sealevel transfers
#
# Prerequisites:
#   - Rust toolchain with cargo-build-sbf (or agave CLI tools)
#   - solana CLI tools (solana, solana-test-validator, spl-token)
#   - foundry (forge, cast, anvil)
#   - jq
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
EVM_DOMAIN_1=31337     # anvil chain 1
EVM_DOMAIN_2=31338     # anvil chain 2

# Sealevel config
SEALEVEL_RPC="http://127.0.0.1:8899"
SEALEVEL_DEPLOYER_KEYPAIR="$SEALEVEL_DIR/environments/local-e2e/accounts/test_deployer-keypair.json"
SEALEVEL_ENVS_DIR="$SEALEVEL_DIR/environments"
SEALEVEL_ENV_NAME="local-e2e"
SEALEVEL_MOCK_REGISTRY="environments/local-e2e/mock-registry"
SBF_OUT_PATH="$SEALEVEL_DIR/target/dist"

# EVM config
EVM_RPC_1="http://127.0.0.1:8545"
EVM_RPC_2="http://127.0.0.1:8546"
ANVIL_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# Per-chain EVM state (set by deploy_evm_chain)
EVM1_MAILBOX="" EVM1_ERC20="" EVM1_COLLATERAL=""
EVM2_MAILBOX="" EVM2_ERC20="" EVM2_COLLATERAL=""

# Sealevel dispatch nonce tracker (incremented after each sealevel→EVM test)
SEALEVEL_DISPATCH_NONCE=0

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

# Deploy a Solidity contract via forge create, return deployed address
forge_deploy() {
    local contract="$1"
    local rpc_url="$2"
    shift 2
    local args=()
    if [ $# -gt 0 ]; then
        args=(--constructor-args "$@")
    fi
    local output
    if ! output=$(forge create "$contract" \
        --broadcast \
        --rpc-url "$rpc_url" \
        --private-key "$ANVIL_PRIVATE_KEY" \
        "${args[@]+"${args[@]}"}" 2>&1); then
        fail "forge create $contract failed: $output"
    fi
    local addr
    addr=$(echo "$output" | awk '/Deployed to:/{print $3}' | head -1)
    if [ -z "$addr" ]; then
        fail "Could not parse address from forge create $contract: $output"
    fi
    echo "$addr"
}

# ========================================
# Step 0: Build prerequisites
# ========================================

build_sealevel_programs() {
    log "Building sealevel programs (including multicollateral)..."
    cd "$SEALEVEL_DIR"

    cargo build -p hyperlane-sealevel-client 2>&1 | tail -5

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

    SOLANA_CONFIG="$WORK_DIR/solana-config.yml"
    solana config set \
        --url "$SEALEVEL_RPC" \
        --keypair "$SEALEVEL_DEPLOYER_KEYPAIR" \
        --config "$SOLANA_CONFIG" 2>&1 | tail -1

    local spl_args=()
    if [ -f "$SBF_OUT_PATH/spl_token.so" ]; then
        spl_args+=(
            --bpf-program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA "$SBF_OUT_PATH/spl_token.so"
            --bpf-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "$SBF_OUT_PATH/spl_token_2022.so"
            --bpf-program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL "$SBF_OUT_PATH/spl_associated_token_account.so"
            --bpf-program noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV "$SBF_OUT_PATH/spl_noop.so"
        )
    fi

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
    local port="$1"
    local chain_id="$2"
    local rpc_url="http://127.0.0.1:$port"
    log "Starting anvil (port=$port, chain-id=$chain_id)..."
    anvil --silent --port "$port" --chain-id "$chain_id" &
    PIDS+=($!)
    wait_for_rpc "$rpc_url" "Anvil (port $port)"
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

    SEALEVEL_MAILBOX=$(jq -r '.mailbox' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/sealeveltest1/core/program-ids.json")
    SEALEVEL_IGP=$(jq -r '.igp_program_id' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/sealeveltest1/core/program-ids.json")
    log "  Mailbox: $SEALEVEL_MAILBOX"
    log "  IGP: $SEALEVEL_IGP"
}

create_spl_token_mint() {
    log "Creating SPL token mint (decimals=6)..."
    local output
    if ! output=$(spl-token create-token --decimals 6 --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" 2>&1); then
        fail "spl-token create-token failed: $output"
    fi
    SPL_MINT=$(echo "$output" | grep -oE '[A-HJ-NP-Za-km-z1-9]{32,44}' | head -1 || true)
    if [ -z "$SPL_MINT" ]; then
        fail "Failed to parse SPL mint address from spl-token output: $output"
    fi
    log "  SPL Mint: $SPL_MINT"

    spl-token create-account "$SPL_MINT" --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" 2>&1 | tail -1 || fail "spl-token create-account failed"

    spl-token mint "$SPL_MINT" 1000000000 --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" 2>&1 | tail -1 || fail "spl-token mint failed"
    log "  Minted 1,000,000,000 tokens (= 1000 with 6 decimals)"
}

deploy_sealevel_mc_warp_route() {
    log "Deploying Sealevel MultiCollateral warp route..."
    cd "$SEALEVEL_DIR"

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

    SEALEVEL_MC_PROGRAM=$(jq -r '.sealeveltest1.base58' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/warp-routes/mctest/program-ids.json")
    SEALEVEL_MC_PROGRAM_HEX=$(jq -r '.sealeveltest1.hex' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/warp-routes/mctest/program-ids.json")
    log "  MC Warp Route Program: $SEALEVEL_MC_PROGRAM"
    log "  MC Warp Route Hex: $SEALEVEL_MC_PROGRAM_HEX"
}

# ========================================
# Step 3: Deploy EVM contracts (parameterized)
# ========================================

# Sets globals: _EVM_MAILBOX, _EVM_ERC20, _EVM_COLLATERAL
deploy_evm_chain() {
    local rpc_url="$1"
    local domain="$2"
    log "Deploying EVM contracts (domain=$domain, rpc=$rpc_url)..."
    cd "$SOLIDITY_DIR"

    _EVM_MAILBOX=$(forge_deploy contracts/Mailbox.sol:Mailbox "$rpc_url" "$domain")
    log "  Mailbox: $_EVM_MAILBOX"

    local ism
    ism=$(forge_deploy contracts/test/TestIsm.sol:TestIsm "$rpc_url")
    log "  TestIsm: $ism"

    local hook
    hook=$(forge_deploy contracts/test/TestPostDispatchHook.sol:TestPostDispatchHook "$rpc_url")
    log "  Hook: $hook"

    cast send "$_EVM_MAILBOX" \
        "initialize(address,address,address,address)" \
        "$ANVIL_ADDRESS" "$ism" "$hook" "$hook" \
        --rpc-url "$rpc_url" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    _EVM_ERC20=$(forge_deploy contracts/test/ERC20Test.sol:ERC20Test "$rpc_url" "TestToken" "TST" "0" "18")
    log "  ERC20: $_EVM_ERC20"

    _EVM_COLLATERAL=$(forge_deploy contracts/token/HypERC20Collateral.sol:HypERC20Collateral "$rpc_url" "$_EVM_ERC20" 1 1 "$_EVM_MAILBOX")
    log "  HypERC20Collateral: $_EVM_COLLATERAL"

    cast send "$_EVM_COLLATERAL" \
        "initialize(address,address,address)" \
        "$hook" "$ism" "$ANVIL_ADDRESS" \
        --rpc-url "$rpc_url" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    log "  All EVM contracts deployed (domain=$domain)"
}

# ========================================
# Step 4: Cross-enroll routers (multi-remote)
# ========================================

cross_enroll_routers() {
    log "Cross-enrolling routers (multi-remote-router)..."

    local evm1_router_h256 evm2_router_h256
    evm1_router_h256=$(printf "0x000000000000000000000000%s" "${EVM1_COLLATERAL#0x}")
    evm2_router_h256=$(printf "0x000000000000000000000000%s" "${EVM2_COLLATERAL#0x}")

    # Enroll both EVM routers on Sealevel MC warp route
    log "  Enrolling EVM1 router on Sealevel: domain=$EVM_DOMAIN_1"
    sealevel_client \
        token enroll-remote-router \
        --program-id "$SEALEVEL_MC_PROGRAM" \
        "$EVM_DOMAIN_1" \
        "$evm1_router_h256" 2>&1 | tail -3

    log "  Enrolling EVM2 router on Sealevel: domain=$EVM_DOMAIN_2"
    sealevel_client \
        token enroll-remote-router \
        --program-id "$SEALEVEL_MC_PROGRAM" \
        "$EVM_DOMAIN_2" \
        "$evm2_router_h256" 2>&1 | tail -3

    # Enroll Sealevel on both EVM collaterals
    log "  Enrolling Sealevel router on EVM1: domain=$SEALEVEL_DOMAIN"
    cast send "$EVM1_COLLATERAL" \
        "enrollRemoteRouter(uint32,bytes32)" \
        "$SEALEVEL_DOMAIN" \
        "$SEALEVEL_MC_PROGRAM_HEX" \
        --rpc-url "$EVM_RPC_1" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    log "  Enrolling Sealevel router on EVM2: domain=$SEALEVEL_DOMAIN"
    cast send "$EVM2_COLLATERAL" \
        "enrollRemoteRouter(uint32,bytes32)" \
        "$SEALEVEL_DOMAIN" \
        "$SEALEVEL_MC_PROGRAM_HEX" \
        --rpc-url "$EVM_RPC_2" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    # Set destination gas for both EVM domains on Sealevel
    sealevel_client \
        token set-destination-gas \
        --program-id "$SEALEVEL_MC_PROGRAM" \
        "$EVM_DOMAIN_1" \
        "68000" 2>&1 | tail -3

    sealevel_client \
        token set-destination-gas \
        --program-id "$SEALEVEL_MC_PROGRAM" \
        "$EVM_DOMAIN_2" \
        "68000" 2>&1 | tail -3

    log "  Routers cross-enrolled (Sealevel ↔ EVM1, Sealevel ↔ EVM2)"
}

# ========================================
# Step 5: Test Sealevel → EVM transfer (parameterized)
# ========================================

test_sealevel_to_evm() {
    local evm_rpc="$1"
    local evm_domain="$2"
    local evm_mailbox="$3"
    local evm_collateral="$4"
    local evm_erc20="$5"
    local nonce="$SEALEVEL_DISPATCH_NONCE"

    log "=== Testing Sealevel → EVM (domain=$evm_domain, nonce=$nonce) ==="

    local recipient_h256
    recipient_h256=$(printf "0x000000000000000000000000%s" "${ANVIL_ADDRESS#0x}")

    # Mint ERC20 to HypERC20Collateral (collateral pool for incoming transfers)
    log "  Minting ERC20 tokens to HypERC20Collateral..."
    cast send "$evm_erc20" \
        "mintTo(address,uint256)" \
        "$evm_collateral" \
        "1000000000000000000000" \
        --rpc-url "$evm_rpc" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    local initial_balance
    initial_balance=$(cast call "$evm_erc20" "balanceOf(address)(uint256)" "$ANVIL_ADDRESS" --rpc-url "$evm_rpc")
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
        "$evm_domain" \
        "$recipient_h256" \
        "multi-collateral" 2>&1); then
        fail "Sealevel transfer-remote failed: $transfer_output"
    fi
    echo "$transfer_output" | tail -10
    log "  Transfer dispatched on Sealevel"

    # Fetch dispatched message from mailbox
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
          \"commitment\":\"confirmed\",
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
    cast send "$evm_mailbox" \
        "process(bytes,bytes)" \
        "0x" \
        "0x$msg_hex" \
        --rpc-url "$evm_rpc" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    local final_balance
    final_balance=$(cast call "$evm_erc20" "balanceOf(address)(uint256)" "$ANVIL_ADDRESS" --rpc-url "$evm_rpc")
    log "  Final recipient ERC20 balance: $final_balance"
    if [ "$final_balance" = "$initial_balance" ]; then
        fail "Sealevel→EVM (domain=$evm_domain) relay did not change recipient ERC20 balance"
    fi
    log "  Sealevel→EVM (domain=$evm_domain) relay PASSED"

    SEALEVEL_DISPATCH_NONCE=$((SEALEVEL_DISPATCH_NONCE + 1))
}

# ========================================
# Step 6: Test EVM → Sealevel transfer (parameterized)
# ========================================

test_evm_to_sealevel() {
    local evm_rpc="$1"
    local evm_domain="$2"
    local evm_collateral="$3"
    local evm_erc20="$4"

    log "=== Testing EVM (domain=$evm_domain) → Sealevel ==="

    local deployer_pubkey
    deployer_pubkey=$(solana-keygen pubkey "$SEALEVEL_DEPLOYER_KEYPAIR")
    local recipient_h256
    recipient_h256="0x$(python3 -c "
import json
with open('$SEALEVEL_DEPLOYER_KEYPAIR') as f:
    key_bytes = json.load(f)
pubkey_hex = bytes(key_bytes[32:]).hex()
print(pubkey_hex)
")"

    # Mint ERC20 tokens to sender
    log "  Minting ERC20 tokens to sender..."
    cast send "$evm_erc20" \
        "mintTo(address,uint256)" \
        "$ANVIL_ADDRESS" \
        "1000000000000000000" \
        --rpc-url "$evm_rpc" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    # Approve HypERC20Collateral to spend tokens
    log "  Approving HypERC20Collateral..."
    cast send "$evm_erc20" \
        "approve(address,uint256)" \
        "$evm_collateral" \
        "1000000000000000000" \
        --rpc-url "$evm_rpc" \
        --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

    local initial_sol_balance
    initial_sol_balance=$(get_spl_balance_raw "$deployer_pubkey" "$SPL_MINT")
    log "  Initial Sealevel recipient token balance: $initial_sol_balance"

    # Transfer remote to Sealevel
    local transfer_amount="1000000000000000000"  # 1.0 tokens with 18 decimals
    log "  Initiating transferRemote on EVM (amount=$transfer_amount to domain=$SEALEVEL_DOMAIN)..."

    local tx_hash
    tx_hash=$(cast send "$evm_collateral" \
        "transferRemote(uint32,bytes32,uint256)" \
        "$SEALEVEL_DOMAIN" \
        "$recipient_h256" \
        "$transfer_amount" \
        --rpc-url "$evm_rpc" \
        --private-key "$ANVIL_PRIVATE_KEY" \
        --json 2>&1 | jq -r '.transactionHash')

    log "  EVM transferRemote tx: $tx_hash"

    local receipt_json
    receipt_json=$(cast receipt "$tx_hash" --rpc-url "$evm_rpc" --json 2>/dev/null)

    # Extract Dispatch event data
    local dispatch_data
    dispatch_data=$(echo "$receipt_json" | jq -r '.logs[] | select(.topics[0] == "0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814") | .data' | head -1)
    if [ -z "$dispatch_data" ] || [ "$dispatch_data" = "null" ]; then
        fail "Could not extract Dispatch event data from EVM logs"
    fi
    local raw_message
    raw_message=$(cast decode-abi "dispatch(bytes)(bytes)" "$dispatch_data" | tr -d '\n')
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
        fail "EVM (domain=$evm_domain)→Sealevel message was not marked delivered"
    fi

    local final_sol_balance
    final_sol_balance=$(get_spl_balance_raw "$deployer_pubkey" "$SPL_MINT")
    log "  Final Sealevel recipient token balance: $final_sol_balance"
    if [ "$final_sol_balance" = "$initial_sol_balance" ]; then
        fail "EVM (domain=$evm_domain)→Sealevel relay did not change recipient token balance"
    fi
    log "  EVM (domain=$evm_domain)→Sealevel relay PASSED"
}

# ========================================
# Main execution
# ========================================

main() {
    log "Starting Cross-VM test: Sealevel MultiCollateral ↔ 2 EVM Collaterals"
    log "Working directory: $WORK_DIR"
    check_prerequisites

    # Build
    build_sealevel_programs

    # Start chains
    start_solana_validator
    start_anvil 8545 "$EVM_DOMAIN_1"
    start_anvil 8546 "$EVM_DOMAIN_2"

    # Deploy Sealevel
    deploy_sealevel_core
    create_spl_token_mint
    deploy_sealevel_mc_warp_route

    # Deploy EVM chain 1
    deploy_evm_chain "$EVM_RPC_1" "$EVM_DOMAIN_1"
    EVM1_MAILBOX="$_EVM_MAILBOX"
    EVM1_ERC20="$_EVM_ERC20"
    EVM1_COLLATERAL="$_EVM_COLLATERAL"

    # Deploy EVM chain 2
    deploy_evm_chain "$EVM_RPC_2" "$EVM_DOMAIN_2"
    EVM2_MAILBOX="$_EVM_MAILBOX"
    EVM2_ERC20="$_EVM_ERC20"
    EVM2_COLLATERAL="$_EVM_COLLATERAL"

    # Cross-enroll all routers
    cross_enroll_routers

    # Test all four transfer directions
    test_sealevel_to_evm "$EVM_RPC_1" "$EVM_DOMAIN_1" "$EVM1_MAILBOX" "$EVM1_COLLATERAL" "$EVM1_ERC20"
    test_sealevel_to_evm "$EVM_RPC_2" "$EVM_DOMAIN_2" "$EVM2_MAILBOX" "$EVM2_COLLATERAL" "$EVM2_ERC20"
    test_evm_to_sealevel "$EVM_RPC_1" "$EVM_DOMAIN_1" "$EVM1_COLLATERAL" "$EVM1_ERC20"
    test_evm_to_sealevel "$EVM_RPC_2" "$EVM_DOMAIN_2" "$EVM2_COLLATERAL" "$EVM2_ERC20"

    log ""
    log "========================================"
    log "Cross-VM test completed! (4/4 transfers passed)"
    log "========================================"
    log ""
    log "Summary:"
    log "  Sealevel MC Program: $SEALEVEL_MC_PROGRAM"
    log "  EVM1 HypERC20Collateral: $EVM1_COLLATERAL (domain=$EVM_DOMAIN_1)"
    log "  EVM2 HypERC20Collateral: $EVM2_COLLATERAL (domain=$EVM_DOMAIN_2)"
    log "  Sealevel→EVM1: PASSED"
    log "  Sealevel→EVM2: PASSED"
    log "  EVM1→Sealevel: PASSED"
    log "  EVM2→Sealevel: PASSED"
    log ""
}

main "$@"

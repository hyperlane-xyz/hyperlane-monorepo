#!/bin/bash
# Main MC routing e2e:
# - SVM MC source -> local SVM MC sibling
# - SVM MC source -> EVM MC sibling A
# - SVM MC source -> EVM MC sibling B

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEALEVEL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SEALEVEL_DIR/../.." && pwd)"
SOLIDITY_DIR="$REPO_ROOT/solidity"
MULTICOLLATERAL_DIR="$SOLIDITY_DIR/multicollateral"

SEALEVEL_DOMAIN=13375
EVM_DOMAIN=31337

SEALEVEL_RPC="http://127.0.0.1:8899"
EVM_RPC="http://127.0.0.1:8545"

SEALEVEL_DEPLOYER_KEYPAIR="$SEALEVEL_DIR/environments/local-e2e/accounts/test_deployer-keypair.json"
SEALEVEL_ENVS_DIR="$SEALEVEL_DIR/environments"
SEALEVEL_ENV_NAME="local-e2e"
SEALEVEL_MOCK_REGISTRY="environments/local-e2e/mock-registry"
SBF_OUT_PATH="$SEALEVEL_DIR/target/dist"

ANVIL_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
SEALEVEL_DEPLOYER_PUBKEY="E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty"

WORK_DIR=$(mktemp -d)
LEDGER_DIR=$(mktemp -d)
PIDS=()
BUILD_SBF_MODE=""
SEALEVEL_DISPATCH_NONCE=0

SOURCE_MINT=""
LOCAL_MINT=""
SOURCE_PROGRAM=""
SOURCE_PROGRAM_HEX=""
SOURCE_ESCROW=""
LOCAL_PROGRAM=""
LOCAL_PROGRAM_HEX=""
LOCAL_ESCROW=""

SEALEVEL_MAILBOX=""
EVM_MAILBOX=""
EVM_MC_A=""
EVM_MC_B=""
EVM_ERC20_A=""
EVM_ERC20_B=""
EVM_MC_A_HEX=""
EVM_MC_B_HEX=""

trap 'cleanup' EXIT

log() {
  echo "=== [mc-e2e] $*"
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
  fail "Missing cargo build-sbf tooling"
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

sealevel_client() {
  "$SEALEVEL_DIR/target/debug/hyperlane-sealevel-client" \
    --config "$SOLANA_CONFIG" \
    --keypair "$SEALEVEL_DEPLOYER_KEYPAIR" \
    "$@"
}

forge_deploy() {
  local workdir="$1"
  local contract="$2"
  local rpc_url="$3"
  shift 3
  local args=()
  if [ $# -gt 0 ]; then
    args=(--constructor-args "$@")
  fi
  local output
  if ! output=$(cd "$workdir" && forge create "$contract" \
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

address_to_h256() {
  printf "0x000000000000000000000000%s" "${1#0x}"
}

random_h256() {
  python3 - <<'PY'
import secrets
print("0x" + secrets.token_hex(32))
PY
}

uint_sub() {
  python3 - "$1" "$2" <<'PY'
import sys
print(int(sys.argv[1]) - int(sys.argv[2]))
PY
}

assert_uint_eq() {
  local actual="$1"
  local expected="$2"
  local context="$3"
  [ "$actual" = "$expected" ] || fail "$context: expected $expected, got $actual"
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
  echo "$resp" | jq -r '[.result.value[].account.data.parsed.info.tokenAmount.amount // "0" | tonumber] | add // 0'
}

get_token_account_balance_raw() {
  local account="$1"
  local resp
  resp=$(rpc_post "$SEALEVEL_RPC" "{
    \"jsonrpc\":\"2.0\",
    \"id\":1,
    \"method\":\"getTokenAccountBalance\",
    \"params\":[\"$account\"]
  }")
  echo "$resp" | jq -r '.result.value.amount // "0"'
}

wait_for_token_account_balance_change() {
  local account="$1"
  local initial="$2"
  local attempt=0
  while [ $attempt -lt 10 ]; do
    local current
    current=$(get_token_account_balance_raw "$account")
    if [ "$current" != "$initial" ]; then
      echo "$current"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "$initial"
}

wait_for_spl_balance_change() {
  local owner="$1"
  local mint="$2"
  local initial="$3"
  local attempt=0
  while [ $attempt -lt 10 ]; do
    local current
    current=$(get_spl_balance_raw "$owner" "$mint")
    if [ "$current" != "$initial" ]; then
      echo "$current"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "$initial"
}

extract_router_from_message() {
  local msg_hex="$1"
  python3 - "$msg_hex" <<'PY'
import sys
msg = bytes.fromhex(sys.argv[1])
assert len(msg) >= 77, "message too short"
print("0x" + msg[45:77].hex())
PY
}

fetch_dispatched_message_hex() {
  local nonce="$1"
  local filter_b64
  filter_b64=$(python3 - "$nonce" <<'PY'
import base64, struct, sys
print(base64.b64encode(b"DISPATCH" + struct.pack("<I", int(sys.argv[1]))).decode())
PY
)
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
  echo "$accounts_json" | python3 -c '
import base64, binascii, json, sys
obj = json.load(sys.stdin)
accounts = obj.get("result", [])
if not accounts:
    raise SystemExit("no dispatched message account found")
raw = base64.b64decode(accounts[0]["account"]["data"][0])
if len(raw) <= 53:
    raise SystemExit("account data too short")
print(binascii.hexlify(raw[53:]).decode(), end="")
'
}

build_sealevel_programs() {
  log "Building sealevel programs..."
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
}

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
  log "Starting anvil..."
  anvil --silent --port 8545 --chain-id "$EVM_DOMAIN" &
  PIDS+=($!)
  wait_for_rpc "$EVM_RPC" "Anvil"
}

deploy_sealevel_core() {
  log "Deploying Sealevel core..."
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
  log "  Mailbox: $SEALEVEL_MAILBOX"
}

create_spl_mint() {
  local decimals="$1"
  local amount_raw="$2"
  local output mint
  if ! output=$(spl-token create-token --decimals "$decimals" --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" 2>&1); then
    fail "spl-token create-token failed: $output"
  fi
  mint=$(echo "$output" | grep -oE '[A-HJ-NP-Za-km-z1-9]{32,44}' | head -1 || true)
  [ -n "$mint" ] || fail "Failed to parse SPL mint address"
  spl-token create-account "$mint" --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" >/dev/null 2>&1
  if [ "$amount_raw" != "0" ]; then
    spl-token mint "$mint" "$amount_raw" --url "$SEALEVEL_RPC" --config "$SOLANA_CONFIG" --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" >/dev/null 2>&1
  fi
  echo "$mint"
}

deploy_sealevel_mc_route() {
  local warp_route_name="$1"
  local mint="$2"
  local token_config="$WORK_DIR/$warp_route_name-token-config.json"
  cat > "$token_config" <<EOF
{
  "sealeveltest1": {
    "type": "multiCollateral",
    "token": "$mint",
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
    --warp-route-name "$warp_route_name" \
    --token-config-file "$token_config" \
    --registry "$SEALEVEL_MOCK_REGISTRY" \
    --ata-payer-funding-amount 1000000000 2>&1 | tail -10
}

query_escrow_account() {
  local program_id="$1"
  local output
  output=$(sealevel_client token query --program-id "$program_id" multi-collateral 2>&1)
  echo "$output" | sed -n 's/.*escrow_account (key, bump)=(\([^,]*\),.*/\1/p' | head -1
}

deploy_sealevel_routes() {
  log "Creating SPL mints..."
  SOURCE_MINT=$(create_spl_mint 6 1000000000)
  LOCAL_MINT=$(create_spl_mint 6 0)
  log "  Source mint: $SOURCE_MINT"
  log "  Local sibling mint: $LOCAL_MINT"

  log "Deploying Sealevel MC source..."
  deploy_sealevel_mc_route "mcsource" "$SOURCE_MINT"
  SOURCE_PROGRAM=$(jq -r '.sealeveltest1.base58' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/warp-routes/mcsource/program-ids.json")
  SOURCE_PROGRAM_HEX=$(jq -r '.sealeveltest1.hex' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/warp-routes/mcsource/program-ids.json")
  SOURCE_ESCROW=$(query_escrow_account "$SOURCE_PROGRAM")
  [ -n "$SOURCE_ESCROW" ] || fail "Failed to determine source escrow account"

  log "Deploying Sealevel MC local sibling..."
  deploy_sealevel_mc_route "mclocal" "$LOCAL_MINT"
  LOCAL_PROGRAM=$(jq -r '.sealeveltest1.base58' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/warp-routes/mclocal/program-ids.json")
  LOCAL_PROGRAM_HEX=$(jq -r '.sealeveltest1.hex' "$SEALEVEL_ENVS_DIR/$SEALEVEL_ENV_NAME/warp-routes/mclocal/program-ids.json")
  LOCAL_ESCROW=$(query_escrow_account "$LOCAL_PROGRAM")
  [ -n "$LOCAL_ESCROW" ] || fail "Failed to determine local sibling escrow account"

  sealevel_client token set-local-domain --program-id "$SOURCE_PROGRAM" "$SEALEVEL_DOMAIN" >/dev/null
  sealevel_client token set-local-domain --program-id "$LOCAL_PROGRAM" "$SEALEVEL_DOMAIN" >/dev/null

  spl-token mint "$LOCAL_MINT" 1000000000 "$LOCAL_ESCROW" \
    --url "$SEALEVEL_RPC" \
    --config "$SOLANA_CONFIG" \
    --fee-payer "$SEALEVEL_DEPLOYER_KEYPAIR" >/dev/null 2>&1

  log "  Source program: $SOURCE_PROGRAM"
  log "  Local program: $LOCAL_PROGRAM"
}

deploy_evm_chain() {
  log "Deploying EVM mailbox + 2 MC siblings..."
  local ism hook

  EVM_MAILBOX=$(forge_deploy "$SOLIDITY_DIR" contracts/Mailbox.sol:Mailbox "$EVM_RPC" "$EVM_DOMAIN")
  ism=$(forge_deploy "$SOLIDITY_DIR" contracts/test/TestIsm.sol:TestIsm "$EVM_RPC")
  hook=$(forge_deploy "$SOLIDITY_DIR" contracts/test/TestPostDispatchHook.sol:TestPostDispatchHook "$EVM_RPC")

  cast send "$EVM_MAILBOX" \
    "initialize(address,address,address,address)" \
    "$ANVIL_ADDRESS" "$ism" "$hook" "$hook" \
    --rpc-url "$EVM_RPC" \
    --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

  EVM_ERC20_A=$(forge_deploy "$SOLIDITY_DIR" contracts/test/ERC20Test.sol:ERC20Test "$EVM_RPC" "TokenA" "TKA" "0" "18")
  EVM_ERC20_B=$(forge_deploy "$SOLIDITY_DIR" contracts/test/ERC20Test.sol:ERC20Test "$EVM_RPC" "TokenB" "TKB" "0" "18")
  EVM_MC_A=$(forge_deploy "$MULTICOLLATERAL_DIR" contracts/MultiCollateral.sol:MultiCollateral "$EVM_RPC" "$EVM_ERC20_A" 1 1 "$EVM_MAILBOX")
  EVM_MC_B=$(forge_deploy "$MULTICOLLATERAL_DIR" contracts/MultiCollateral.sol:MultiCollateral "$EVM_RPC" "$EVM_ERC20_B" 1 1 "$EVM_MAILBOX")

  cast send "$EVM_MC_A" \
    "initialize(address,address,address)" \
    "$hook" "$ism" "$ANVIL_ADDRESS" \
    --rpc-url "$EVM_RPC" \
    --private-key "$ANVIL_PRIVATE_KEY" >/dev/null
  cast send "$EVM_MC_B" \
    "initialize(address,address,address)" \
    "$hook" "$ism" "$ANVIL_ADDRESS" \
    --rpc-url "$EVM_RPC" \
    --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

  cast send "$EVM_MC_A" \
    "enrollRemoteRouter(uint32,bytes32)" \
    "$SEALEVEL_DOMAIN" "$SOURCE_PROGRAM_HEX" \
    --rpc-url "$EVM_RPC" \
    --private-key "$ANVIL_PRIVATE_KEY" >/dev/null
  cast send "$EVM_MC_B" \
    "enrollRemoteRouter(uint32,bytes32)" \
    "$SEALEVEL_DOMAIN" "$SOURCE_PROGRAM_HEX" \
    --rpc-url "$EVM_RPC" \
    --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

  cast send "$EVM_ERC20_A" "mintTo(address,uint256)" "$EVM_MC_A" "1000000000000000000000" \
    --rpc-url "$EVM_RPC" --private-key "$ANVIL_PRIVATE_KEY" >/dev/null
  cast send "$EVM_ERC20_B" "mintTo(address,uint256)" "$EVM_MC_B" "1000000000000000000000" \
    --rpc-url "$EVM_RPC" --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

  EVM_MC_A_HEX=$(address_to_h256 "$EVM_MC_A")
  EVM_MC_B_HEX=$(address_to_h256 "$EVM_MC_B")
  log "  Mailbox: $EVM_MAILBOX"
  log "  MC A: $EVM_MC_A"
  log "  MC B: $EVM_MC_B"
}

cross_enroll_routes() {
  log "Cross-enrolling MC routes..."
  sealevel_client token enroll-remote-router --program-id "$SOURCE_PROGRAM" "$EVM_DOMAIN" "$EVM_MC_A_HEX" >/dev/null
  sealevel_client token enroll-multicollateral-router --program-id "$SOURCE_PROGRAM" "$EVM_DOMAIN" "$EVM_MC_B_HEX" >/dev/null
  sealevel_client token enroll-multicollateral-router --program-id "$SOURCE_PROGRAM" "$SEALEVEL_DOMAIN" "$LOCAL_PROGRAM_HEX" >/dev/null
  sealevel_client token enroll-multicollateral-router --program-id "$LOCAL_PROGRAM" "$SEALEVEL_DOMAIN" "$SOURCE_PROGRAM_HEX" >/dev/null
  sealevel_client token set-destination-gas --program-id "$SOURCE_PROGRAM" "$EVM_DOMAIN" "68000" >/dev/null
}

test_svm_to_local_sibling() {
  log "Testing SVM source -> local SVM sibling..."
  local transfer_output

  if ! transfer_output=$(sealevel_client \
    token transfer-remote-to \
    --program-id "$SOURCE_PROGRAM" \
    "$SEALEVEL_DEPLOYER_KEYPAIR" \
    "1000000" \
    "$SEALEVEL_DOMAIN" \
    "$SEALEVEL_DEPLOYER_PUBKEY" \
    "$LOCAL_PROGRAM_HEX" \
    multi-collateral 2>&1); then
    fail "Local sibling transfer failed: $transfer_output"
  fi

  echo "$transfer_output" | rg -q "HandleLocal completed" || fail "Local sibling path did not execute HandleLocal"
  echo "$transfer_output" | rg -q "same-chain transfer completed" || fail "Local sibling path did not complete same-chain MC transfer"
  echo "$transfer_output" | rg -q "remote_amount=1000000000000000000" || fail "Local sibling path missing exact remote amount"
  log "  Local sibling transfer PASSED"
}

test_svm_to_evm_sibling() {
  local label="$1"
  local target_router="$2"
  local evm_erc20="$3"
  log "Testing SVM source -> EVM $label..."

  local recipient_h256 initial final msg_hex routed_router expected_router transfer_output
  recipient_h256=$(address_to_h256 "$ANVIL_ADDRESS")
  initial=$(cast call "$evm_erc20" "balanceOf(address)(uint256)" "$ANVIL_ADDRESS" --rpc-url "$EVM_RPC" | awk '{print $1}')

  if ! transfer_output=$(sealevel_client \
    token transfer-remote-to \
    --program-id "$SOURCE_PROGRAM" \
    "$SEALEVEL_DEPLOYER_KEYPAIR" \
    "1000000" \
    "$EVM_DOMAIN" \
    "$recipient_h256" \
    "$target_router" \
    multi-collateral 2>&1); then
    fail "EVM $label transfer dispatch failed: $transfer_output"
  fi
  echo "$transfer_output" | rg -q "transfer_remote_to completed" || fail "EVM $label missing completion log"

  msg_hex=$(fetch_dispatched_message_hex "$SEALEVEL_DISPATCH_NONCE")
  routed_router=$(extract_router_from_message "$msg_hex")
  expected_router=$(echo "$target_router" | tr '[:upper:]' '[:lower:]')
  routed_router=$(echo "$routed_router" | tr '[:upper:]' '[:lower:]')
  [ "$routed_router" = "$expected_router" ] || fail "Expected message recipient $expected_router, got $routed_router"

  cast send "$EVM_MAILBOX" \
    "process(bytes,bytes)" \
    "0x" \
    "0x$msg_hex" \
    --rpc-url "$EVM_RPC" \
    --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

  final=$(cast call "$evm_erc20" "balanceOf(address)(uint256)" "$ANVIL_ADDRESS" --rpc-url "$EVM_RPC" | awk '{print $1}')
  assert_uint_eq "$(uint_sub "$final" "$initial")" "1000000000000000000" "EVM $label recipient delta"
  SEALEVEL_DISPATCH_NONCE=$((SEALEVEL_DISPATCH_NONCE + 1))
  log "  EVM $label transfer PASSED"
}

test_unenrolled_target_rejected() {
  log "Testing unenrolled target rejection..."
  local recipient_h256 bogus_router transfer_output source_initial source_final
  recipient_h256=$(address_to_h256 "$ANVIL_ADDRESS")
  bogus_router=$(random_h256)
  source_initial=$(get_spl_balance_raw "$SEALEVEL_DEPLOYER_PUBKEY" "$SOURCE_MINT")

  if transfer_output=$(sealevel_client \
    token transfer-remote-to \
    --program-id "$SOURCE_PROGRAM" \
    "$SEALEVEL_DEPLOYER_KEYPAIR" \
    "1000000" \
    "$EVM_DOMAIN" \
    "$recipient_h256" \
    "$bogus_router" \
    multi-collateral 2>&1); then
    fail "Unenrolled target unexpectedly succeeded: $transfer_output"
  fi

  echo "$transfer_output" | rg -q "not enrolled for domain" || fail "Expected unenrolled-target error, got: $transfer_output"
  source_final=$(get_spl_balance_raw "$SEALEVEL_DEPLOYER_PUBKEY" "$SOURCE_MINT")
  assert_uint_eq "$source_final" "$source_initial" "source balance after unenrolled target"
  log "  Unenrolled target rejection PASSED"
}

main() {
  log "Starting SVM MultiCollateral routing e2e"
  check_prerequisites
  build_sealevel_programs
  start_solana_validator
  start_anvil
  deploy_sealevel_core
  deploy_sealevel_routes
  deploy_evm_chain
  cross_enroll_routes

  test_unenrolled_target_rejected
  test_svm_to_local_sibling
  test_svm_to_evm_sibling "sibling A" "$EVM_MC_A_HEX" "$EVM_ERC20_A"
  test_svm_to_evm_sibling "sibling B" "$EVM_MC_B_HEX" "$EVM_ERC20_B"

  log "========================================"
  log "MC routing e2e passed"
  log "Source SVM program: $SOURCE_PROGRAM"
  log "Local SVM sibling: $LOCAL_PROGRAM"
  log "EVM sibling A: $EVM_MC_A"
  log "EVM sibling B: $EVM_MC_B"
  log "========================================"
}

main "$@"

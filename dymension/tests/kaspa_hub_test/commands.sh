## EXPLANATION 

### Need

# - [ ] Local hub
# - [ ] Kaspa testnet 10
# - [ ] WPRC node for kaspa testnet 10

## INSTRUCTIONS

#### PREFACE

# Recommended tabs:
# 1. dymd
# 2. wrpc node
# 3. validator
# 4. relayer 
# 5. deposit/withdraw

#### 0. Setup escrow

# in libs/kaspa/demo/user
cargo run validator
# THES VALUES MUST CORRESPOND WITH agent-config.json, AND the CLI commands below. Do NOT unescape json quotes
#   "validator_ism_addr": "\"0xc09dddbd26fb6dcea996ba643e8c2685c03cad5a7\"",
#   "validator_ism_priv_key": "c02e29cb65e55b3af3d8dee5d7a30504ed927436caf2e53e1e965cbd2639aced",
#   "validator_escrow_secret": "\"11013bc86d1cb199a2324130c808e90ad37d07ae8f490d063b2fb9d9aa2e898f\"",
#   "validator_escrow_pub_key": "02b1c7b586c8a0387a3c844f6a5471130bb7992346d3e906642cfd5dfce8a8129d",
#   "multisig_escrow_addr": "kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr"

# in rusty-kaspa/wallet/native
cargo run
# TODO: finish native wallet cli instructions
# seed escrow with a few kas

#### 1. Setup HUB

MONODIR=/Users/danwt/Documents/dym/d-hyperlane-monorepo

# clean slate
trash ~/.hyperlane; trash ~/.dymension
mkdir ~/.hyperlane; cp -r $MONODIR/dymension/tests/kaspa_hub_test/chains ~/.hyperlane/chains

# install hub binary (dymension/)
make install
source $MONODIR/dymension/tests/kaspa_hub_test/env.sh
scripts/setup_local.sh
dymd start --log_level=debug

# setup bridge objects on hub
CLI_VALS="0xc09dddbd26fb6dcea996ba643e8c2685c03cad57" # has (hex) key c18908a1bbe0ec588cd6522d2b02af3076a2f2c562a09bb8bf5a40f6e9a0ef1b
CLI_THRESHOLD="1"
CLI_REMOTE_ROUTER_ADDRESS="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # arbitrary // TODO: refine, this is the 'contract' on kaspa
dymd q kas setup-bridge --validators "$CLI_VALS" --threshold "$CLI_THRESHOLD" --remote-router-address "$CLI_REMOTE_ROUTER_ADDRESS" "${HUB_FLAGS[@]}"

#### 2. START KASPA RPC NODE

# start wprc node
# https://github.com/dymensionxyz/hyperlane-monorepo/blob/ad21e8a6554999033b39949cb80c13c208bc3581/dymension/libs/kaspa/demo/multisig/README.md#L32

#### 3. SETUP VALIDATOR

AGENT_TMP=/Users/danwt/Documents/dym/aaa-dym-notes/all_tasks/tasks/202505_feat_kaspa/practical/e2e/tmp
DB_RELAYER=$AGENT_TMP/dbs/hyperlane_db_relayer
DB_VALIDATOR=$AGENT_TMP/dbs/hyperlane_db_validator
export SIGS_VAL=$AGENT_TMP/signatures
export CONFIG_FILES=$MONODIR/dymension/tests/kaspa_hub_test/agent-config.json

trash $AGENT_TMP/dbs
mkdir $AGENT_TMP/dbs

cargo build --release --bin validator

# ./target/release/validator \
RUST_BACKTRACE=1 cargo run --release --bin validator -- \
  --db $DB_VALIDATOR \
  --originChainName kaspatest10 \
  --reorgPeriod 1 \
  --checkpointSyncer.type localStorage \
  --checkpointSyncer.path $SIGS_VAL \
  --validator.key 0xc02e29cb65e55b3af3d8dee5d7a30504ed927436caf2e53e1e965cbd2639aced \
  --metrics-port 9090 \
  --log.level info 

#### 4. BOOTSTRAP HUB

ISM=$(hub q hyperlane ism isms -o json | jq -r '.isms[0].id')
MAILBOX=$(hub q hyperlane mailboxes -o json | jq -r '.mailboxes[0].id')
TOKEN_ID=$(hub q warp tokens -o json | jq -r '.tokens[0].id')
ESCROW_ADDR=kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr
HUB_USER_ADDR=$(dymd keys show -a hub-user) #dym139mq752delxv78jvtmwxhasyrycufsvrw4aka9

dymd q auth module-account gov -o json | jq -r '.account.value.address' # dym10d07y265gmmuvt4z0w9aw880jnsr700jgllrna

curl -X 'GET' 'https://api-tn10.kaspa.org/addresses/kaspatest%3Apzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr/utxos' -H 'accept: application/json'

OUTPOINT="5e1cf6784e7af1808674a252eb417d8fa003135190dd4147caf98d8463a7e73a"
# need to convert outpoint to base64 when passing to hub
echo "5e1cf6784e7af1808674a252eb417d8fa003135190dd4147caf98d8463a7e73a" | xxd -r -p | base64 # Xhz2eE568YCGdKJS60F9j6ADE1GQ3UFHyvmNhGOn5zo=

dymd tx gov submit-proposal $MONODIR/dymension/tests/kaspa_hub_test/bootstrap.json \
  --from hub-user \
  --gas auto \
  --fees 10000000000000000adym \
  -y 

#### 5. SETUP RELAYER 

# TODO: cleanups, kaspatest10.signer not actually used

./target/release/relayer \
    --db $DB_RELAYER \
    --relayChains kaspatest10,dymension \
    --allowLocalCheckpointSyncers true \
    --defaultSigner.key $HYP_KEY \
    --chains.dymension.signer.type cosmosKey \
    --chains.dymension.signer.prefix dym \
    --chains.dymension.signer.key $HYP_KEY \
    --chains.kaspatest10.signer.type cosmosKey \
    --chains.kaspatest10.signer.prefix dym \
    --chains.kaspatest10.signer.key $HYP_KEY \
    --metrics-port 9091 \
    --log.level debug 

#### 5. SUBMIT DEPOSITS/WITHDRAWALS

# *DEPOSITS*

# <token id> <recipient> <amt>
dymd q forward hl-message-kaspa "0x726f757465725f61707000000000000000000000000000020000000000000000" "dym139mq752delxv78jvtmwxhasyrycufsvrw4aka9" 100000000 

# in hyperlane-monorepo/dymension/libs/kaspa/demo/relayer
# (100 billion sompi = 1 TKAS)
# TODO: add 0x prefix to hex string, requires a change on parser
cargo run -- deposit \
  --escrow-address kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr \
  --amount 100000000 \
  --payload 030000000004d10892ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff804b267ca0726f757465725f6170700000000000000000000000000002000000000000000000000000000000000000000089760f514dcfcccf1e4c5edc6bf6041931c4c18300000000000000000000000000000000000000000000000000000000000003e8 \
  --wrpc-url localhost:17210 \
  --network-id testnet-10 \
  --wallet-secret lkjsdf

cargo run 

# *WITHDRAWALS*

# convert your kaspa address to something that can be interpreted by Hub CLI
# in demos/user
cargo run recipient kaspatest:qr0jmjgh2sx88q9gdegl449cuygp5rh6yarn5h9fh97whprvcsp2ksjkx456f # (dan tn10 address)
# output like 0xdf2dc917540c7380a86e51fad4b8e1101a0efa27473a5ca9b97ceb846cc402ab

# dymd tx warp transfer [token-id] [destination-domain] [recipient] [amount] [flags]
# kastest10 domain is 80808082
dymd tx warp transfer 0x726f757465725f61707000000000000000000000000000020000000000000000 80808082 0xdf2dc917540c7380a86e51fad4b8e1101a0efa27473a5ca9b97ceb846cc402ab 100 --max-hyperlane-fee 1000adym  "${HUB_FLAGS[@]}"

###############################################################
###############################################################
###############################################################
###############################################################
###############################################################
#### APPENDIX: DEBUG TIPS 

# check that validator server is working
curl -X POST -H "Content-Type: application/json" -d '{}' http://localhost:9090/kaspa-ping

# emergency fix for hooks
# mailbox, default hook (e.g. IGP), required hook (e.g. merkle tree)
dymd tx hyperlane hooks noop create "${HUB_FLAGS[@]}"
NOOP_HOOK=$(curl -s http://localhost:1318/hyperlane/v1/noop_hooks | jq '.noop_hooks.[0].id' -r); echo $NOOP_HOOK;
dymd tx hyperlane mailbox set $MAILBOX --default-hook $NOOP_HOOK --required-hook $NOOP_HOOK "${HUB_FLAGS[@]}"
dymd tx hyperlane mailbox set $MAILBOX --default-hook 0x726f757465725f706f73745f6469737061746368000000000000000000000002 --required-hook 0x726f757465725f706f73745f6469737061746368000000030000000000000000 "${HUB_FLAGS[@]}"

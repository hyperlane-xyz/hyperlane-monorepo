## EXPLANATION 

### Need

# - [ ] Local hub
# - [ ] Kaspa testnet 10
# - [ ] WPRC node for kaspa testnet 10

## INSTRUCTIONS

#### PREFACE

# Recommended terminal tabs:
# 1. dymd
# 2. wrpc node
# 3. validator
# 4. relayer 
# 5. deposit/withdraw

###################################
#### Step 0. START KASPA RPC NODE
#### This is needed for WPRC queries and wallet connections. It takes a while to sync

# see instructions at
# https://github.com/dymensionxyz/hyperlane-monorepo/blob/ad21e8a6554999033b39949cb80c13c208bc3581/dymension/libs/kaspa/demo/multisig/README.md#L32

###################################
#### Step 1. Setup escrow
#### Create hyperlane validators keys and addresses, and kaspa escrow keys and address, seed the escrow

# in libs/kaspa/demo/user
cargo run validator-with-escrow
#   "validator_ism_addr": "\"0xc09dddbd26fb6dcea996ba643e8c2685c03cad5a7\"",
#   "validator_ism_priv_key": "c02e29cb65e55b3af3d8dee5d7a30504ed927436caf2e53e1e965cbd2639aced",
#   "validator_escrow_secret": "\"11013bc86d1cb199a2324130c808e90ad37d07ae8f490d063b2fb9d9aa2e898f\"",
#   "validator_escrow_pub_key": "02b1c7b586c8a0387a3c844f6a5471130bb7992346d3e906642cfd5dfce8a8129d",
#   "multisig_escrow_addr": "kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr"
VALIDATOR_ISM_ADDR="0xc09dddbd26fb6dcea996ba643e8c2685c03cad5a7"
VALIDATOR_ISM_PRIV_KEY="c02e29cb65e55b3af3d8dee5d7a30504ed927436caf2e53e1e965cbd2639aced"
VALIDATOR_ESCROW_SECRET="\"11013bc86d1cb199a2324130c808e90ad37d07ae8f490d063b2fb9d9aa2e898f\""
VALIDATOR_ESCROW_PUB_KEY="02b1c7b586c8a0387a3c844f6a5471130bb7992346d3e906642cfd5dfce8a8129d"
ESCROW_ADDR="kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr"
# THES VALUES MUST CORRESPOND WITH agent-config.json (in this directory, REQUIRES EDITING)  Do NOT unescape json quotes

# in rusty-kaspa/wallet/native
cargo run
open
connect
select
send 1 $ESCROW_ADDR
# seed escrow with a few kas 

###################################
#### Step 2. Setup HUB
#### Deploy hyperlane entities 

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
REMOTE_ROUTER_ADDRESS="0x0000000000000000000000000000000000000000000000000000000000000000" # no smart contracts on kaspa 
dymd q kas setup-bridge --validators "$VALIDATOR_ISM_ADDR" --threshold 1 --remote-router-address "$REMOTE_ROUTER_ADDRESS" "${HUB_FLAGS[@]}"
MAILBOX=$(dymd q hyperlane mailboxes -o json | jq -r '.mailboxes[0].id')
# popoulate agent-config.json with hub mailbox id

###################################
#### Step 3. SETUP VALIDATOR
#### It will start listening for relayer requests

AGENT_TMP=/Users/danwt/Documents/dym/aaa-dym-notes/all_tasks/tasks/202505_feat_kaspa/practical/e2e/tmp
DB_VALIDATOR=$AGENT_TMP/dbs/hyperlane_db_validator
DB_RELAYER=$AGENT_TMP/dbs/hyperlane_db_relayer
export CONFIG_FILES=$MONODIR/dymension/tests/kaspa_hub_test/agent-config.json

trash $AGENT_TMP/dbs
mkdir $AGENT_TMP/dbs


# RUST_BACKTRACE=1 cargo run --release --bin validator -- \
./target/release/validator \
  --db $DB_VALIDATOR \
  --originChainName kaspatest10 \
  --reorgPeriod 1 \
  --checkpointSyncer.type localStorage \
  --checkpointSyncer.path ARBITRARY_VALUE_FOOBAR \
  --validator.key "0x${VALIDATOR_ISM_PRIV_KEY}" \
  --metrics-port 9090 \
  --log.level info 

###################################
#### Step 4. BOOTSTRAP HUB
#### Need to declare to the hub that the bridge is ready, by specifying the escrow seed outpoint
#### We submit a gov proposal with the seed outpoint and mailbox

# First construct the proposal

dymd q auth module-account gov -o json | jq -r '.account.value.address' # get the authority dym10d07y265gmmuvt4z0w9aw880jnsr700jgllrna

# get the kaspa seed outpoint

curl -X 'GET' 'https://api-tn10.kaspa.org/addresses/kaspatest%3Apzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr/utxos' -H 'accept: application/json' # TODO: query escrow address (fix url encoding)
OUTPOINT="5e1cf6784e7af1808674a252eb417d8fa003135190dd4147caf98d8463a7e73a"
# need to convert outpoint from hex to base64 when passing to hub (note, zero index does not render)
echo $OUTPOINT | xxd -r -p | base64 # Xhz2eE568YCGdKJS60F9j6ADE1GQ3UFHyvmNhGOn5zo=
# note, reverse is ` echo $base64 | base64 -D | xxd -p `

# query the hub entities and reference them (REQUIRES EDITING bootstrap.json)
ISM=$(dymd q hyperlane ism isms -o json | jq -r '.isms[0].id')

dymd tx gov submit-proposal $MONODIR/dymension/tests/kaspa_hub_test/bootstrap.json \
  --from hub-user \
  --gas auto \
  --fees 10000000000000000adym \
  -y 

dymd tx gov vote 1 yes "${HUB_FLAGS[@]}" 


###################################
#### Step 5. SETUP RELAYER 
#### It will monitor kaspa and hub for deposits and withdrawals and make http calls direct to the validator

# TODO: remove unused/unnecessary things (i.e. I think kaspatest10.signer not actually used)

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

###################################
#### Step 6. TEST DEPOSITS/WITHDRAWALS
#### Phase 1, deposit: generate a HL message using Hub CLI tool and pass this in kaspa deposit tool

# *DEPOSITS*

TOKEN_ID=$(dymd q warp tokens -o json | jq -r '.tokens[0].id')
HUB_USER_ADDR=$(dymd keys show -a hub-user) #dym139mq752delxv78jvtmwxhasyrycufsvrw4aka9

DEPOSIT_AMT=100000000 # 100 million sompi = 1 TKAS

# get the HL message
# <token id> <recipient> <amt>
dymd q forward hl-message-kaspa $TOKEN_ID $HUB_USER_ADDR $DEPOSIT_AMT 

# in hyperlane-monorepo/dymension/libs/kaspa/demo/relayer
# NOTE: payload should not have 0x prefix
# manual put payload here (TODO: use env var)
cargo run -- deposit \
  --escrow-address $ESCROW_ADDR \
  --amount $DEPOSIT_AMT \
  --payload 030000000004d10892ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff804b267ca0726f757465725f6170700000000000000000000000000002000000000000000000000000000000000000000089760f514dcfcccf1e4c5edc6bf6041931c4c1830000000000000000000000000000000000000000000000000000000005f5e100 \
  --wrpc-url localhost:17210 \
  --network-id testnet-10 \
  --wallet-secret lkjsdf

# *WITHDRAWALS*

# convert your kaspa address to something that can be interpreted by Hub CLI
# in demos/user
KASPA_RECIPIENT=$(cargo run recipient kaspatest:qr0jmjgh2sx88q9gdegl449cuygp5rh6yarn5h9fh97whprvcsp2ksjkx456f) # (Dan's tn10 address, put your own address here)
# output like 0xdf2dc917540c7380a86e51fad4b8e1101a0efa27473a5ca9b97ceb846cc402ab

# initiate the transfer
# dymd tx warp transfer [token-id] [destination-domain] [recipient] [amount] [flags]
# kastest10 domain is 80808082
WITHDRAW_AMT=20000002 # just enough to not be dust
dymd tx warp transfer $TOKEN_ID $KASTEST_DOMAIN $KASPA_RECIPIENT $WITHDRAW_AMT --max-hyperlane-fee 1000adym  "${HUB_FLAGS[@]}"

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

dymd tx kas indicate-progress --metadata AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfx31wOGjRk5MCQZOZhentVmmOhLE0M+Yji+bn2KYNMmWbVrYnFkIl/tXjhAM6scXm71gg30+pd0tGiQ5LrC+TGzd6er/un6SCbmj57jPzFkAgA5k8RIRjYWzJmhG5cA37Dqo15p5cKj/rGLRzFIyxQkPkOsGAba6cAiTezd7gHwAb2WO4YySk+cU1Y1lufSWkoIZFFBXkIA2FReg7PAGYYLdMxDu2OcrbfdzEPzy6wqRtkQcklcGw46BRaSWrXanowhw= --payload /Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/tests/kaspa_hub_test/scratch/indication.json "${HUB_FLAGS[@]}"

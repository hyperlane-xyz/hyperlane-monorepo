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

# in rust/main
cargo run -p kaspa-tools -- validator create local
Validator infos: {
  "validator_ism_addr": "0x172ed756c7c04f6e5370f9fc181f85b7779643eb",
  "validator_ism_priv_key": "a4d1c634e1b8cde0fc53013dfc62e1789535b59d15b0bbf4c8fbd2d4e79bc132",
  "validator_escrow_secret": "\"afa4bcc6e5828eb28d70138ea784a32e0212d3560dfcdfac85bfa1dbabb11ac9\"",
  "validator_escrow_pub_key": "027b75fcbedee53f82ebc43c19a69697100afad2df27202f107c994c740e9df5b8",
  "multisig_escrow_addr": "kaspatest:prmapgdl0nsdqjsmd45fjykxuq3242g4npryzkqe3aeqq9yhrp20k20ymjrlk"
}
VALIDATOR_ISM_ADDR="0x172ed756c7c04f6e5370f9fc181f85b7779643eb"
VALIDATOR_ISM_PRIV_KEY="a4d1c634e1b8cde0fc53013dfc62e1789535b59d15b0bbf4c8fbd2d4e79bc132"
VALIDATOR_ESCROW_SECRET="\"afa4bcc6e5828eb28d70138ea784a32e0212d3560dfcdfac85bfa1dbabb11ac9\""
VALIDATOR_ESCROW_PUB_KEY="027b75fcbedee53f82ebc43c19a69697100afad2df27202f107c994c740e9df5b8"
ESCROW_ADDR="kaspatest:prmapgdl0nsdqjsmd45fjykxuq3242g4npryzkqe3aeqq9yhrp20k20ymjrlk"
# THESE VALUES MUST CORRESPOND WITH agent-config.json (in this directory, REQUIRES EDITING)  Do NOT unescape json quotes
# Update:
# kaspatest10.kaspaValidators[0].escrowPub = VALIDATOR_ESCROW_PUB_KEY
# kaspatest10.escrowAddress = ESCROW_ADDR
# kaspatest10.kaspaEscrowPrivateKey = VALIDATOR_ESCROW_SECRET

#~~~~~~~
# Seed escrow with 1 TKAS
# (Requires wallet from https://github.com/dymensionxyz/hyperlane-deployments/blob/main/e2e/assets/kaspa-wallet-funded-testnet-relayer/kaspa.wallet in ~/.kaspa)
cargo run -- deposit \
  --escrow-address $ESCROW_ADDR \
  --amount 100000000 \
  --wrpc-url localhost:17210 \
  --network-id testnet-10 \
  --wallet-secret lkjsdf

#~~~~~~~
# Or run with your own wallet
open
connect
select
send $ESCROW_ADDR 1

# PUT THE WALLET SECRET KEY IN agent-config.json – "kaspatest10.walletSecret"

###################################
#### Step 2. Setup HUB
#### Deploy hyperlane entities 

MONODIR=/Users/danwt/Documents/dym/d-hyperlane-monorepo

# clean slate
trash ~/.hyperlane; trash ~/.dymension
mkdir ~/.hyperlane; cp -r $MONODIR/dymension/tests/kaspa_hub_test_kas/chains ~/.hyperlane/chains

# install hub binary (dymension/)
make install
source $MONODIR/dymension/tests/kaspa_hub_test_kas/env.sh
scripts/setup_local.sh
dymd start --log_level=debug

# setup bridge objects on hub
REMOTE_ROUTER_ADDRESS="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # no smart contracts on kaspa 
dymd tx kas setup-bridge --validators "$VALIDATOR_ISM_ADDR" --threshold 1 --remote-router-address "$REMOTE_ROUTER_ADDRESS" "${HUB_FLAGS[@]}" --counterparty-domain $KASTEST_DOMAIN --hub-domain $HUB_DOMAIN

MAILBOX=$(dymd q hyperlane mailboxes -o json | jq -r '.mailboxes[0].id')
TOKEN_ID=$(dymd q warp tokens -o json | jq -r '.tokens[0].id')
KAS_TOKEN_ID=$(dymd q warp remote-routers $TOKEN_ID -o json | jq -r '.remote_routers[0].receiver_contract')
# popoulate agent-config.json with hubMailboxId, hubTokenId, kasTokenId:
# hubMailboxId = MAILBOX
# hubTokenId = TOKEN_ID
# kasTokenId = KAS_TOKEN_ID

###################################
#### Step 3. SETUP VALIDATOR
#### It will start listening for relayer requests

AGENT_TMP=/Users/danwt/Documents/dym/aaa-dym-notes/all_tasks/tasks/202505_feat_kaspa/practical/e2e/tmp
DB_VALIDATOR=$AGENT_TMP/dbs/hyperlane_db_validator
DB_RELAYER=$AGENT_TMP/dbs/hyperlane_db_relayer
export CONFIG_FILES=$MONODIR/dymension/tests/kaspa_hub_test_kas/agent-config.json

trash $AGENT_TMP/dbs
mkdir $AGENT_TMP/dbs

## Build the binaries. In rust/main:
cargo build --release --bin relayer --bin validator

./target/release/validator \
    --db $DB_VALIDATOR \
    --originChainName kaspatest10 \
    --reorgPeriod 1 \
    --checkpointSyncer.type localStorage \
    --checkpointSyncer.path ARBITRARY_VALUE_FOOBAR \
    --validator.key "0x${VALIDATOR_ISM_PRIV_KEY}" \
    --metrics-port 9090 \
    --log.level info

# Or build & run right away. RUST_BACKTRACE helps debug.
RUST_BACKTRACE=full cargo run --release --bin validator -- \
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

dymd tx gov submit-proposal $MONODIR/dymension/tests/kaspa_hub_test_kas/bootstrap.json \
  --from hub-user \
  --gas auto \
  --fees 10000000000000000adym \
  -y 

dymd tx gov vote 1 yes "${HUB_FLAGS[@]}"


###################################
#### Step 5. SETUP RELAYER 
#### It will monitor kaspa and hub for deposits and withdrawals and make http calls direct to the validator

# TODO: remove unused/unnecessary things (i.e. I think kaspatest10.signer not actually used)

# fund the relayer address on the Hub

dymd tx bank send $HUB_KEY_WITH_FUNDS $RELAYER_ADDR 1000000000000000000adym "${HUB_FLAGS[@]}"

# Run the relayer
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

# Or build & run right away. RUST_BACKTRACE helps debug.
RUST_BACKTRACE=1 cargo run --release --bin relayer -- \
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

##############
### *DEPOSITS*

HUB_USER_ADDR=$(dymd keys show -a hub-user) #dym139mq752delxv78jvtmwxhasyrycufsvrw4aka9

DEPOSIT_AMT=10000000000 # 10_000 million sompi = 100 TKAS

# get the HL message
# <token id> <recipient> <amt> <kas_token_id>
# TODO: Command "hl-message-kaspa" is deprecated, use 'create-hl-message --source=kaspa --dest=hub' instead
dymd q forward hl-message-kaspa $TOKEN_ID $HUB_USER_ADDR $DEPOSIT_AMT $KAS_TOKEN_ID $KASTEST_DOMAIN $HUB_DOMAIN

# NOTE: payload should not have 0x prefix
HL_PAYLOAD=$(dymd q forward hl-message-kaspa $TOKEN_ID $HUB_USER_ADDR $DEPOSIT_AMT $KAS_TOKEN_ID $KASTEST_DOMAIN $HUB_DOMAIN | cut -c 3-)

# In hyperlane-monorepo/dymension/libs/kaspa/demo/relayer (Removed https://github.com/dymensionxyz/hyperlane-monorepo/pull/326)
# Put payload in the arguments
cargo run -- \
  --escrow-address $ESCROW_ADDR \
  --amount $DEPOSIT_AMT \
  --rpcserver localhost:17210 \
  --wallet-secret 123456qwe \
  --only-deposit \
  --payload "${HL_PAYLOAD}"

# Validate the result

KAS_TOKEN_DENOM=$(dymd q warp tokens -o json | jq -r '.tokens[0].origin_denom')

# Should have $DEPOSIT_AMT Kaspa tokens
dymd q bank balance $HUB_USER_ADDR $KAS_TOKEN_DENOM

#################
### *WITHDRAWALS*

# convert your kaspa address to something that can be interpreted by Hub CLI
# in tooling/
KASPA_RECIPIENT=$(cargo run recipient kaspatest:qrjmshvw4ucgyhm8rlc257g4mz9fy64kf0gkr8tgktsdwtplvtcs26durxukf) # (Dan's tn10 address, put your own address here)
# output like 0xdf2dc917540c7380a86e51fad4b8e1101a0efa27473a5ca9b97ceb846cc402ab

# initiate the transfer
# dymd tx warp transfer [token-id] [destination-domain] [recipient] [amount] [flags]
# kastest10 domain is 897658017
WITHDRAW_AMT=4000000002 # more than min deposit, 40 KAS
dymd tx warp transfer $TOKEN_ID $KASTEST_DOMAIN $KASPA_RECIPIENT $WITHDRAW_AMT --max-hyperlane-fee 1000adym  "${HUB_FLAGS[@]}"

# Validate the result

# get the transaction ID of new anchor outpoint on the Hub
# it can be compared agains the change UTXO in the Kaspa explorer
echo $(dymd q kas outpoint -o json | jq -r '.outpoint.transaction_id') | base64 -D | xxd -p

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

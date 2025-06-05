export BASE_PATH="/Users/danwt/Documents/dym/d-hyperlane-monorepo"
export HUB_BASE_PATH="/Users/danwt/Documents/dym/d-dymension/scripts/hyperlane_test"

#########################################################################################
#########################################################################################
# Q: What is this?
# A: Some commands to run Dymension Hub + Anvil instance and connect them and relay between them
# Scenario: Dymension Hub will have collateral ADYM and Anvil will have synthetic memo
#########################################################################################

# clean slate
trash ~/.hyperlane; trash ~/.dymension

##############################################################################################
##############################################################################################
# PART 1: Start chains and deploy contracts

################
# ENV: 

source $HUB_BASE_PATH/env.sh

export HYP_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
export HYP_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export HYP_ADDR_ZEROS="0x000000000000000000000000f39Fd6e51aad88F6F4ce6aB8827279cffFb92266" # this is zero padded regular address
export RELAYER_ADDR="dym15428vq2uzwhm3taey9sr9x5vm6tk78ewtfeeth" # relayer derives from HYP_KEY
export HUB_DOMAIN=1260813472 
export ETH_DOMAIN=31337
export DENOM="adym"

################
# START NODES: 

# HUB
cd dymension/ # hub repo
bash scripts/setup_local.sh
dymd start --log_level=debug
# see ping pub for explorer

# ETHEREUM
anvil --port 8545 --chain-id 31337 --block-time 1 # make sure rollapp-evm not listening on same port
# see otterscan for explorer

#################
# DEPLOY HYPERLANE CORE TO ETH:
cd hyperlane-monorepo/dymension/tests/ethereum_test

trash ~/.hyperlane; mkdir ~/.hyperlane; cp -r chains ~/.hyperlane/chains;

# only deploy anvil0, without block explorer
hyperlane core deploy

################
# HUB: 

hub tx hyperlane ism create-noop "${HUB_FLAGS[@]}"
sleep 7;
ISM=$(curl -s http://localhost:1318/hyperlane/v1/isms | jq '.isms.[0].id' -r); echo $ISM;

hub tx hyperlane hooks noop create "${HUB_FLAGS[@]}"
sleep 7;
NOOP_HOOK=$(curl -s http://localhost:1318/hyperlane/v1/noop_hooks | jq '.noop_hooks.[0].id' -r); echo $NOOP_HOOK;

hub tx hyperlane mailbox create $ISM $HUB_DOMAIN "${HUB_FLAGS[@]}"
sleep 7;
MAILBOX=$(curl -s http://localhost:1318/hyperlane/v1/mailboxes   | jq '.mailboxes.[0].id' -r); echo $MAILBOX;

hub tx hyperlane hooks merkle create $MAILBOX "${HUB_FLAGS[@]}"
sleep 7;
MERKLE_HOOK=$(curl -s http://localhost:1318/hyperlane/v1/merkle_tree_hooks | jq '.merkle_tree_hooks.[0].id' -r); echo $MERKLE_HOOK;

# update mailbox again. default hook (e.g. IGP), required hook (e.g. merkle tree)
hub tx hyperlane mailbox set $MAILBOX --default-hook $NOOP_HOOK --required-hook $MERKLE_HOOK "${HUB_FLAGS[@]}"

hub tx hyperlane-transfer create-collateral-token $MAILBOX $DENOM "${HUB_FLAGS[@]}"
sleep 7;
TOKEN_ID=$(curl -s http://localhost:1318/hyperlane/v1/tokens | jq '.tokens.[0].id' -r); echo $TOKEN_ID

################
# ANVIL: 

# cd hyperlane-monorepo/dymension/tests/ethereum_test

# populate addresses https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/chains/kyvetestnet/addresses.yaml
touch ~/.hyperlane/chains/dymension/tests/addresses.yaml
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'interchainGasPaymaster' -v $NOOP_HOOK
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'interchainSecurityModule' -v $ISM
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'mailbox' -v $MAILBOX
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'merkleTreeHook' -v $MERKLE_HOOK
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'validatorAnnounce' -v $MAILBOX
# then manually add quotes to the addresses (!!)

# also, check configs/warp-route-deployment.yaml matches
dasel put -f configs/warp-route-deployment.yaml 'dymension.token' -v $TOKEN_ID
dasel put -f configs/warp-route-deployment.yaml 'dymension.foreignDeployment' -v $TOKEN_ID
dasel put -f configs/warp-route-deployment.yaml 'dymension.mailbox' -v $MAILBOX
# then manually add quotes to the addresses (!!)

# now use hyperlane CLI to deploy only the contracts needed on anvil, making use of a foreign deployment config for dymension side
# it will say to deploy to dymension too, but it won't
hyperlane warp deploy

################
# FINISH HUB SETUP: 

ETH_TOKEN_CONTRACT_RAW=$(dasel -f ~/.hyperlane/deployments/warp_routes/ADYM/anvil0-config.yaml -r yaml 'tokens.index(0).addressOrDenom'); echo $ETH_TOKEN_CONTRACT_RAW;
# manual step TODO: automate
ETH_TOKEN_CONTRACT="0x0000000000000000000000004A679253410272dd5232B3Ff7cF5dbB88f295319" # Need to zero pad it! (with 0x000000000000000000000000)

hub tx hyperlane-transfer enroll-remote-router $TOKEN_ID $ETH_DOMAIN $ETH_TOKEN_CONTRACT 0 "${HUB_FLAGS[@]}" # gas = 0
sleep 7;
curl -s http://localhost:1318/hyperlane/v1/tokens/$TOKEN_ID/remote_routers # check

##############################################################################################
##############################################################################################
# PART 1: SETUP RELAYERS AND VALIDATORS
# https://docs.hyperlane.xyz/docs/guides/deploy-hyperlane-local-agents
# build agent binaries if needed

MONO_WORKING_DIR=/Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/tests/ethereum_test
RELAYER_DB=$MONO_WORKING_DIR/tmp/hyperlane_db_relayer
trash $MONO_WORKING_DIR/tmp/
mkdir $MONO_WORKING_DIR/tmp/

#################################
# RELAYING
# https://docs.hyperlane.xyz/docs/operate/relayer/run-relayer

# regen config
cd hyperlane-monorepo/dymension/tests/ethereum_test
hyperlane registry agent-config --chains anvil0,dymension # DO NOT USE, DOES NOT PROPERLY INCLUDE GRPC URLS, USE PRECONFIGURED

export CONFIG_FILES=$MONO_WORKING_DIR/configs/agent-config.json
# see reference https://docs.hyperlane.xyz/docs/operate/config-reference#config_files

cd rust/main

# need to fund relayer
dymd tx bank send hub-user $RELAYER_ADDR 1000000000000000000000adym "${HUB_FLAGS[@]}"

./target/release/relayer \
    --db $RELAYER_DB \
    --relayChains anvil0,dymension \
    --allowLocalCheckpointSyncers true \
    --defaultSigner.key $HYP_KEY \
    --metrics-port 9091 \
    --chains.dymension.signer.type cosmosKey \
    --chains.dymension.signer.prefix dym \
    --chains.dymension.signer.key $HYP_KEY \
    --log.level debug

#################################
# DO A TRANSFER HUB -> ETHEREUM

AMT=1000
hub tx hyperlane-transfer transfer $TOKEN_ID $ETH_DOMAIN $HYP_ADDR_ZEROS $AMT "${HUB_FLAGS[@]}" --max-hyperlane-fee 1000adym --gas-limit 10000000000
sleep 5;
curl -s http://localhost:1318/hyperlane/v1/tokens/$TOKEN_ID/bridged_supply

# If relaying worked, should have amt tokens here
cast call $ETH_TOKEN_CONTRACT_RAW "balanceOf(address)(uint256)" $HYP_ADDR --rpc-url http://localhost:8545

# fund relayer
dymd tx bank send hub-user $RELAYER_ADDR 1000000000000000000000adym "${HUB_FLAGS[@]}"

HUB_RECEIVER_ADDR_NATIVE="dym1yvq7swunxwduq5kkmuftqccxgqk3f6nsaf3sqz"
HUB_RECEIVER_ADDR=$(dymd q forward hl-eth-recipient $HUB_RECEIVER_ADDR_NATIVE)
# args are destination, recipient, amount
AMT=5
DEMO_MEMO="0x68656c6c6f" # 'hello'
cast send $ETH_TOKEN_CONTRACT_RAW "transferRemoteMemo(uint32,bytes32,uint256,bytes)" $HUB_DOMAIN $HUB_RECEIVER_ADDR $AMT $DEMO_MEMO --private-key $HYP_KEY --rpc-url http://localhost:8545
# note: if using a native token type on ethereum, need to also send some eth ('--value 1')

# confirm tx has memo event on hub
# confirm tx has memo event on anvil
cast call $ETH_TOKEN_CONTRACT_RAW "memoOf(bytes32)(bytes)" $HUB_RECEIVER_ADDR --rpc-url http://localhost:8545

dymd q bank balances $HUB_RECEIVER_ADDR_NATIVE

##############################################################################################
##############################################################################################
# APPENDIX: DEBUGGING

# eth balance:
cast balance $HYP_ADDR --rpc-url http://localhost:8545

# Explorer, uses https://github.com/otterscan/otterscan
docker pull otterscan/otterscan:latest
docker run -p 5100:80 \
  -e OTTERSCAN_RPC_URL="http://host.docker.internal:8545" \
   otterscan/otterscan:latest
# visit http://localhost:5100/

# Hub: https://github.com/ping-pub/explorer
yarn --ignore-engines && yarn serve
# visit http://localhost:5173/

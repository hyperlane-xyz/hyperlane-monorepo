trash ~/.hyperlane; trash ~/.dymension
anvil --port 8545 --chain-id 31337 --block-time 1

mkdir ~/.hyperlane; cp -r /Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/ethereum_test/chains ~/.hyperlane/chains

export HYP_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

cp /Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/ethereum_test/configs/core-config.yaml configs

hyperlane core deploy

# run steps from ethereum_test/commands.sh, up to but not including token

hub tx hyperlane-transfer create-synthetic-token $MAILBOX "${HUB_FLAGS[@]}"
sleep 7;
TOKEN_ID=$(curl -s http://localhost:1318/hyperlane/v1/tokens | jq '.tokens.[0].id' -r); echo $TOKEN_ID


touch ~/.hyperlane/chains/dymension/addresses.yaml
dasel put -f ~/.hyperlane/chains/dymension/addresses.yaml 'interchainGasPaymaster' -v $NOOP_HOOK
dasel put -f ~/.hyperlane/chains/dymension/addresses.yaml 'interchainSecurityModule' -v $ISM
dasel put -f ~/.hyperlane/chains/dymension/addresses.yaml 'mailbox' -v $MAILBOX
dasel put -f ~/.hyperlane/chains/dymension/addresses.yaml 'merkleTreeHook' -v $MERKLE_HOOK
dasel put -f ~/.hyperlane/chains/dymension/addresses.yaml 'validatorAnnounce' -v $MAILBOX

dasel put -f configs/warp-route-deployment.yaml 'dymension.token' -v $TOKEN_ID
dasel put -f configs/warp-route-deployment.yaml 'dymension.foreignDeployment' -v $TOKEN_ID
dasel put -f configs/warp-route-deployment.yaml 'dymension.mailbox' -v $MAILBOX

cd foundry/
forge script script/Foo.s.sol:DeployFoo --rpc-url http://localhost:8545 --private-key $HYP_KEY --broadcast
# put address in warp-route-deployment.yaml anvil0.token

hyperlane warp deploy

FOO_TOKEN_CONTRACT_RAW=0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1
COLLAT_TOKEN_CONTRACT_RAW=$(dasel -f ~/.hyperlane/deployments/warp_routes/FOO/anvil0-config.yaml -r yaml 'tokens.index(0).addressOrDenom'); echo $ETH_TOKEN_CONTRACT_RAW;
# TODO: derive
COLLAT_TOKEN_CONTRACT="0x00000000000000000000000084eA74d481Ee0A5332c457a4d796187F6Ba67fEB" # Need to zero pad it! (with 0x000000000000000000000000)

hub tx hyperlane-transfer enroll-remote-router $TOKEN_ID $ETH_DOMAIN $COLLAT_TOKEN_CONTRACT 0 "${HUB_FLAGS[@]}" # gas = 0

trash /Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/foo_test/tmp/
mkdir /Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/foo_test/tmp/
RELAYER_DB=/Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/foo_test/tmp/hyperlane_db_relayer

# start relayer according to dymension/ethereum_test/commands.sh
export CONFIG_FILES=/Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/ethereum_test/configs/agent-config.json

#################################
# DO A TRANSFER ETHEREUM -> HUB

HUB_RECEIVER_ADDR_NATIVE="dym1yvq7swunxwduq5kkmuftqccxgqk3f6nsaf3sqz"
HUB_RECEIVER_ADDR=$(dymd q forward hl-eth-recipient $HUB_RECEIVER_ADDR_NATIVE)
AMT=5
DEMO_MEMO="0x68656c6c6f" # 'hello'

# confirm balance
cast call $COLLAT_TOKEN_CONTRACT_RAW "balanceOf(address)(uint256)" $HYP_ADDR --rpc-url http://localhost:8545
cast call "0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1" "balanceOf(address)(uint256)" $HYP_ADDR --rpc-url http://localhost:8545

cast send $FOO_TOKEN_CONTRACT_RAW "approve(address,uint256)" "$COLLAT_TOKEN_CONTRACT_RAW" 1000000000000000000 --private-key $HYP_KEY --rpc-url http://localhost:8545

cast send $COLLAT_TOKEN_CONTRACT_RAW "transferRemote(uint32,bytes32,uint256)" $HUB_DOMAIN $HUB_RECEIVER_ADDR $AMT --private-key $HYP_KEY --rpc-url http://localhost:8545
cast send $COLLAT_TOKEN_CONTRACT_RAW "transferRemoteMemo(uint32,bytes32,uint256,bytes)" $HUB_DOMAIN $HUB_RECEIVER_ADDR $AMT $DEMO_MEMO --private-key $HYP_KEY --rpc-url http://localhost:8545

hyperlane warp send --symbol FOO --amount $AMT --recipient $HUB_RECEIVER_ADDR --private-key $HYP_KEY

cast call "0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1" "balanceOf(address)(uint256)" $HYP_ADDR --rpc-url http://localhost:8545





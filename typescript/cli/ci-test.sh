#!/usr/bin/env bash

# set script location as repo root
cd "$(dirname "$0")/../.."

TEST_TYPE_PRESET_HOOK="preset_hook_enabled"
TEST_TYPE_CONFIGURED_HOOK="configure_hook_enabled"
TEST_TYPE_PI_CORE="pi_with_core_chain"

# set the first arg to 'configured_hook' to set the hook config as part of core deployment
# motivation is to test both the bare bone deployment (included in the docs) and the deployment
# with the routing over igp hook (which is closer to production deployment)
TEST_TYPE=$1
if [ -z "$TEST_TYPE" ]; then
    echo "Usage: ci-test.sh <test-type>"
    exit 1
fi

HOOK_FLAG=false
if [ "$TEST_TYPE" == $TEST_TYPE_CONFIGURED_HOOK ]; then
    HOOK_FLAG=true
fi

ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
CHAIN1=anvil1
CHAIN2=anvil2
EXAMPLES_PATH=./examples
DEPLOY_ERC20_PATH=./src/tests/deployTestErc20.ts

# use different chain names and config for pi<>core test
if [ "$TEST_TYPE" == $TEST_TYPE_PI_CORE ]; then
    CHAIN1=anvil
    CHAIN2=ethereum
    EXAMPLES_PATH=./examples/fork
fi

CHAIN1_CAPS=$(echo "${CHAIN1}" | tr '[:lower:]' '[:upper:]')
CHAIN2_CAPS=$(echo "${CHAIN2}" | tr '[:lower:]' '[:upper:]')

CHAIN1_PORT=8545
CHAIN2_PORT=8555

# Optional cleanup for previous runs, useful when running locally
pkill -f anvil
rm -rf /tmp/${CHAIN1}*
rm -rf /tmp/${CHAIN2}*
rm -rf /tmp/relayer

if [[ $OSTYPE == 'darwin'* ]]; then
    # kill child processes on exit, but only locally because
    # otherwise it causes the script exit code to be non-zero
    trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT
fi

# Setup directories for anvil chains
for CHAIN in ${CHAIN1} ${CHAIN2}
do
    mkdir -p /tmp/$CHAIN /tmp/$CHAIN/state  /tmp/$CHAIN/validator /tmp/relayer
    chmod -R 777 /tmp/relayer /tmp/$CHAIN
done

# run the PI chain
anvil --chain-id 31337 -p ${CHAIN1_PORT} --state /tmp/${CHAIN1}/state --gas-price 1 > /dev/null &
sleep 1

# use different chain names for pi<>core test
if [ "$TEST_TYPE" == $TEST_TYPE_PI_CORE ]; then
    # Fetch the RPC of chain to fork
    cd typescript/infra
    RPC_URL=$(yarn ts-node scripts/print-chain-metadatas.ts -e mainnet3 | jq -r ".${CHAIN2}.rpcUrls[0].http")
    cd ../../

    # run the fork chain
    anvil -p ${CHAIN2_PORT} --state /tmp/${CHAIN2}/state --gas-price 1 --fork-url $RPC_URL --fork-retry-backoff 3 --compute-units-per-second 200 > /dev/null &

    # wait for fork to be ready
    while ! cast bn --rpc-url http://127.0.0.1:${CHAIN2_PORT} &> /dev/null; do
    sleep 1
    done
else
    # run a second PI chain
    anvil --chain-id 31338 -p ${CHAIN2_PORT} --state /tmp/${CHAIN2}/state --gas-price 1 > /dev/null &
    sleep 1
fi

set -e

echo "{}" > /tmp/empty-artifacts.json

export DEBUG=hyperlane:*

DEPLOYER=$(cast rpc eth_accounts | jq -r '.[0]')
BEFORE=$(cast balance $DEPLOYER --rpc-url http://127.0.0.1:${CHAIN1_PORT})

echo "Deploying contracts to ${CHAIN1} and ${CHAIN2}"
yarn workspace @hyperlane-xyz/cli run hyperlane deploy core \
    --targets ${CHAIN1},${CHAIN2} \
    --chains ${EXAMPLES_PATH}/anvil-chains.yaml \
    --artifacts /tmp/empty-artifacts.json \
    $(if [ "$HOOK_FLAG" == "true" ]; then echo "--hook ${EXAMPLES_PATH}/hooks.yaml"; fi) \
    --ism ${EXAMPLES_PATH}/ism.yaml \
    --out /tmp \
    --key $ANVIL_KEY \
    --yes

AFTER_CORE=$(cast balance $DEPLOYER --rpc-url http://127.0.0.1:${CHAIN1_PORT})
GAS_PRICE=$(cast gas-price --rpc-url http://127.0.0.1:${CHAIN1_PORT})
CORE_MIN_GAS=$(bc <<< "($BEFORE - $AFTER_CORE) / $GAS_PRICE")
echo "Gas used: $CORE_MIN_GAS"

CORE_ARTIFACTS_PATH=`find /tmp/core-deployment* -type f -exec ls -t1 {} + | head -1`
echo "Core artifacts:"
echo $CORE_ARTIFACTS_PATH
cat $CORE_ARTIFACTS_PATH

AGENT_CONFIG_FILENAME=`ls -t1 /tmp | grep agent-config | head -1`

echo "Deploying hypNative warp route"
yarn workspace @hyperlane-xyz/cli run hyperlane deploy warp \
    --chains ${EXAMPLES_PATH}/anvil-chains.yaml \
    --core $CORE_ARTIFACTS_PATH \
    --config ${EXAMPLES_PATH}/warp-route-deployment.yaml \
    --ism ${EXAMPLES_PATH}/ism.yaml \
    --out /tmp \
    --key $ANVIL_KEY \
    --yes

yarn workspace @hyperlane-xyz/cli run tsx $DEPLOY_ERC20_PATH \
    http://127.0.0.1:$CHAIN1_PORT \
    $CHAIN1 $CHAIN2 $ANVIL_KEY \
    /tmp/warp-collateral-deployment.json \

echo "Deploying hypCollateral warp route"
yarn workspace @hyperlane-xyz/cli run hyperlane deploy warp \
    --chains ${EXAMPLES_PATH}/anvil-chains.yaml \
    --core $CORE_ARTIFACTS_PATH \
    --config /tmp/warp-collateral-deployment.json \
    --ism ${EXAMPLES_PATH}/ism.yaml \
    --out /tmp \
    --key $ANVIL_KEY \
    --yes

exit 0

AFTER_WARP=$(cast balance $DEPLOYER --rpc-url http://127.0.0.1:${CHAIN1_PORT})
GAS_PRICE=$(cast gas-price --rpc-url http://127.0.0.1:${CHAIN1_PORT})
WARP_MIN_GAS=$(bc <<< "($AFTER_CORE - $AFTER_WARP) / $GAS_PRICE")
echo "Gas used: $WARP_MIN_GAS"

echo "Sending test message"
yarn workspace @hyperlane-xyz/cli run hyperlane send message \
    --origin ${CHAIN1} \
    --destination ${CHAIN2} \
    --messageBody "Howdy!" \
    --chains ${EXAMPLES_PATH}/anvil-chains.yaml \
    --core $CORE_ARTIFACTS_PATH \
    --quick \
    --key $ANVIL_KEY \
    | tee /tmp/message1

AFTER_MSG=$(cast balance $DEPLOYER --rpc-url http://127.0.0.1:${CHAIN1_PORT})
GAS_PRICE=$(cast gas-price --rpc-url http://127.0.0.1:${CHAIN1_PORT})
MSG_MIN_GAS=$(bc <<< "($AFTER_WARP - $AFTER_MSG) / $GAS_PRICE")
echo "Gas used: $MSG_MIN_GAS"

MESSAGE1_ID=`cat /tmp/message1 | grep "Message ID" | grep -E -o '0x[0-9a-f]+'`
echo "Message 1 ID: $MESSAGE1_ID"

WARP_ARTIFACTS_FILE=`find /tmp/warp-route-deployment* -type f -exec ls -t1 {} + | head -1`
CHAIN1_ROUTER="${CHAIN1_CAPS}_ROUTER"
declare $CHAIN1_ROUTER=$(cat $WARP_ARTIFACTS_FILE | jq -r ".${CHAIN1}.router")

echo "Sending test warp transfer"
yarn workspace @hyperlane-xyz/cli run hyperlane send transfer \
    --origin ${CHAIN1} \
    --destination ${CHAIN2} \
    --chains ${EXAMPLES_PATH}/anvil-chains.yaml \
    --core $CORE_ARTIFACTS_PATH \
    --router ${!CHAIN1_ROUTER} \
    --quick \
    --key $ANVIL_KEY \
    | tee /tmp/message2

MESSAGE2_ID=`cat /tmp/message2 | grep "Message ID" | grep -E -o '0x[0-9a-f]+'`
echo "Message 2 ID: $MESSAGE2_ID"

cd ./rust
echo "Pre-building validator with cargo"
cargo build --bin validator

# set some default agent env vars, used by both validators and relayer
export HYP_CHAINS_${CHAIN1_CAPS}_BLOCKS_REORGPERIOD=0
export HYP_CHAINS_${CHAIN1_CAPS}_CUSTOMRPCURLS="http://127.0.0.1:${CHAIN1_PORT}"
export HYP_CHAINS_${CHAIN2_CAPS}_BLOCKS_REORGPERIOD=0
export HYP_CHAINS_${CHAIN2_CAPS}_CUSTOMRPCURLS="http://127.0.0.1:${CHAIN2_PORT}"

VALIDATOR_PORT=9091

for CHAIN in ${CHAIN1} ${CHAIN2}
do
    # don't need the second validator for pi<>core test
    if [ "$CHAIN" == "$CHAIN2" ] && [ "$TEST_TYPE" == "$TEST_TYPE_PI_CORE" ]; then
        echo "Skipping validator for $CHAIN2 due to $TEST_TYPE_PI_CORE test type"
        continue
    fi

    VALIDATOR_PORT=$((VALIDATOR_PORT+1))
    echo "Running validator on $CHAIN on port $VALIDATOR_PORT"
    export CONFIG_FILES=/tmp/${AGENT_CONFIG_FILENAME}
    export HYP_ORIGINCHAINNAME=${CHAIN}
    export HYP_VALIDATOR_INTERVAL=1
    export HYP_VALIDATOR_TYPE=hexKey
    export HYP_VALIDATOR_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6
    export HYP_CHECKPOINTSYNCER_TYPE=localStorage
    export HYP_CHECKPOINTSYNCER_PATH=/tmp/${CHAIN}/validator
    export HYP_TRACING_LEVEL=debug
    export HYP_TRACING_FMT=compact
    export HYP_METRICSPORT=$VALIDATOR_PORT

    cargo run --bin validator > /tmp/${CHAIN}/validator-logs.txt &
done

echo "Validator running, sleeping to let it sync"
# This needs to be long to allow time for the cargo build to finish
sleep 15
echo "Done sleeping"

for CHAIN in ${CHAIN1} ${CHAIN2}
do
    # only have one validator announce in pi<>core test
    if [ "$CHAIN" == "$CHAIN2" ] && [ "$TEST_TYPE" == "$TEST_TYPE_PI_CORE" ]; then
        echo "Skipping validator for $CHAIN2 due to $TEST_TYPE_PI_CORE test type"
        continue
    fi

    echo "Validator Announcement for ${CHAIN}:"
    cat /tmp/${CHAIN}/validator/announcement.json
done

echo "Pre-building relayer with cargo"
cargo build --bin relayer

echo "Running relayer"
export CONFIG_FILES=/tmp/${AGENT_CONFIG_FILENAME}
export HYP_RELAYCHAINS=${CHAIN1},${CHAIN2}
export HYP_ALLOWLOCALCHECKPOINTSYNCERS=true
export HYP_DB=/tmp/relayer
export HYP_GASPAYMENTENFORCEMENT='[{"type":"none"}]'
export HYP_CHAINS_${CHAIN1_CAPS}_SIGNER_TYPE=hexKey
export HYP_CHAINS_${CHAIN1_CAPS}_SIGNER_KEY=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
export HYP_CHAINS_${CHAIN2_CAPS}_SIGNER_TYPE=hexKey
export HYP_CHAINS_${CHAIN2_CAPS}_SIGNER_KEY=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
export HYP_METRICSPORT=9090

cargo run --bin relayer > /tmp/relayer/relayer-logs.txt &

# This needs to be long to allow time for the cargo build to finish
echo "Waiting for relayer..."
sleep 20
echo "Done running relayer, checking message delivery statuses"

for i in "1 $MESSAGE1_ID" "2 $MESSAGE2_ID"
do
    set -- $i
    echo "Checking delivery status of $1: $2"
    yarn workspace @hyperlane-xyz/cli run hyperlane status \
        --id $2 \
        --destination ${CHAIN2} \
        --chains ${EXAMPLES_PATH}/anvil-chains.yaml \
        --core $CORE_ARTIFACTS_PATH \
        | tee /tmp/message-status-$1
    if ! grep -q "$2 was delivered" /tmp/message-status-$1; then
        echo "ERROR: Message $1 was not delivered"
        exit 1
    else
        echo "Message $1 was delivered!"
    fi
done

pkill -f anvil
echo "Done"

#!/usr/bin/env bash

# TODO:
#   - trim --options
#   - add configure (in child process run through prompt)
#   - verify stdout against snapshot
#   - use relay
#   - remove all real agent artifacts
#   - consider non-anvil network (live test rollup?)

_main() {
    export LOG_LEVEL=DEBUG

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
        echo "Usage: ci-advanced-test.sh <$TEST_TYPE_PRESET_HOOK | $TEST_TYPE_CONFIGURED_HOOK | $TEST_TYPE_PI_CORE>"
        exit 1
    fi

    prepare_environment_vars;

    prepare_anvil;

    DEPLOYER=$(cast rpc eth_accounts | jq -r '.[0]');

    # TODO: run_hyperlane_core_init;
    # TODO: run_hyperlane_warp_init;
    run_hyperlane_core_deploy;
    run_hyperlane_send_message;
    run_hyperlane_warp_deploy;
    run_hyperlane_warp_send;

    kill_anvil;

    echo "Done";
}

prepare_environment_vars() {
    ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    CHAIN1=anvil1
    CHAIN2=anvil2
    EXAMPLES_PATH=./examples
    TEST_CONFIGS_PATH=./test-configs
    CLI_PATH=./typescript/cli
    REGISTRY_PATH="$TEST_CONFIGS_PATH/anvil"
    CORE_ISM_PATH="$EXAMPLES_PATH/ism.yaml"
    WARP_DEPLOY_CONFIG_PATH="$EXAMPLES_PATH/warp-route-deployment.yaml"
    DEPLOY_ERC20_PATH=./src/tests/deployTestErc20.ts

    # use different chain names and config for pi<>core test
    if [ "$TEST_TYPE" == $TEST_TYPE_PI_CORE ]; then
        CHAIN2=ethereum
        REGISTRY_PATH="$TEST_CONFIGS_PATH/fork"
        CORE_ISM_PATH="$REGISTRY_PATH/ism.yaml"
        WARP_DEPLOY_CONFIG_PATH="$REGISTRY_PATH/warp-route-deployment.yaml"
    fi

    CHAIN1_CAPS=$(echo "${CHAIN1}" | tr '[:lower:]' '[:upper:]')
    CHAIN2_CAPS=$(echo "${CHAIN2}" | tr '[:lower:]' '[:upper:]')

    HOOK_FLAG=false
    if [ "$TEST_TYPE" == $TEST_TYPE_CONFIGURED_HOOK ]; then
        HOOK_FLAG=true
    fi
}

prepare_anvil() {

    CHAIN1_PORT=8545
    CHAIN2_PORT=8555

    # Optional cleanup for previous runs, useful when running locally
    pkill -f anvil
    rm -rf /tmp/${CHAIN1}*
    rm -rf /tmp/${CHAIN2}*
    rm -rf /tmp/relayer
    rm -f $CLI_PATH/$TEST_CONFIGS_PATH/*/chains/*/addresses.yaml
    rm -rf $CLI_PATH/$TEST_CONFIGS_PATH/*/deployments

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
        RPC_URL=$(LOG_LEVEL=error yarn tsx scripts/print-chain-metadatas.ts -e mainnet3 | jq -r ".${CHAIN2}.rpcUrls[0].http")
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
}

reset_anvil() {
    prepare_anvil
}

kill_anvil() {
    pkill -f anvil
}

run_hyperlane_core_deploy() {
    update_deployer_balance;

    echo -e "\nDeploying contracts to ${CHAIN1}"
    yarn workspace @hyperlane-xyz/cli run hyperlane core deploy \
        --registry $REGISTRY_PATH \
        --overrides " " \
        --config ${EXAMPLES_PATH}/core-config.yaml \
        --chain $CHAIN1 \
        --key $ANVIL_KEY \
        --yes

    echo -e "\nDeploying contracts to ${CHAIN2}"
    yarn workspace @hyperlane-xyz/cli run hyperlane core deploy \
        --registry $REGISTRY_PATH \
        --overrides " " \
        --config ${EXAMPLES_PATH}/core-config.yaml \
        --chain $CHAIN2 \
        --key $ANVIL_KEY \
        --yes

    check_deployer_balance;
}

run_hyperlane_warp_deploy() {
    update_deployer_balance;

    echo -e "\nDeploying hypNative warp route"
    yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
        --registry $REGISTRY_PATH \
        --overrides " " \
        --config $WARP_DEPLOY_CONFIG_PATH \
        --key $ANVIL_KEY \
        --yes

    yarn workspace @hyperlane-xyz/cli run tsx $DEPLOY_ERC20_PATH \
        http://127.0.0.1:$CHAIN1_PORT \
        $CHAIN1 $CHAIN2 $ANVIL_KEY \
        /tmp/warp-collateral-deployment.json \

    echo "Deploying hypCollateral warp route"
    yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
        --registry $REGISTRY_PATH \
        --overrides " " \
        --config /tmp/warp-collateral-deployment.json \
        --key $ANVIL_KEY \
        --yes

    check_deployer_balance;
}

run_hyperlane_send_message() {
    update_deployer_balance;

    echo -e "\nSending test message"
    yarn workspace @hyperlane-xyz/cli run hyperlane send message \
        --registry $REGISTRY_PATH \
        --overrides " " \
        --origin ${CHAIN1} \
        --destination ${CHAIN2} \
        --body "Howdy!" \
        --quick \
        --key $ANVIL_KEY \
        --relay \
        | tee /tmp/message1

    check_deployer_balance;

    MESSAGE1_ID=`cat /tmp/message1 | grep "Message ID" | grep -E -o '0x[0-9a-f]+'`
    echo "Message 1 ID: $MESSAGE1_ID"
}

run_hyperlane_warp_send() {
    WARP_CONFIG_FILE="$REGISTRY_PATH/deployments/warp_routes/FAKE/${CHAIN1}-${CHAIN2}-config.yaml"

    echo -e "\nSending test warp transfer"
    yarn workspace @hyperlane-xyz/cli run hyperlane warp send \
        --registry $REGISTRY_PATH \
        --overrides " " \
        --origin ${CHAIN1} \
        --destination ${CHAIN2} \
        --warp ${WARP_CONFIG_FILE} \
        --quick \
        --key $ANVIL_KEY \
        --relay \
        | tee /tmp/message2

    MESSAGE2_ID=`cat /tmp/message2 | grep "Message ID" | grep -E -o '0x[0-9a-f]+'`
    echo "Message 2 ID: $MESSAGE2_ID"
}

run_hyperlane_status() {
    for i in "1 $MESSAGE1_ID" "2 $MESSAGE2_ID"
    do
        set -- $i
        echo "Checking delivery status of $1: $2"
        yarn workspace @hyperlane-xyz/cli run hyperlane status \
            --id $2 \
            --destination ${CHAIN2} \
            --registry $REGISTRY_PATH \
            --overrides " " \
            --relay \
            | tee /tmp/message-status-$1
        if ! grep -q "$2 was delivered" /tmp/message-status-$1; then
            echo "ERROR: Message $1 was not delivered"
            exit 1
        else
            echo "Message $1 was delivered!"
        fi
    done
}

update_deployer_balance() {
    OLD_BALANCE=$(cast balance $DEPLOYER --rpc-url http://127.0.0.1:${CHAIN1_PORT});
}

check_deployer_balance() {
    NEW_BALANCE=$(cast balance $DEPLOYER --rpc-url http://127.0.0.1:${CHAIN1_PORT})
    GAS_PRICE=$(cast gas-price --rpc-url http://127.0.0.1:${CHAIN1_PORT})
    GAS_USED=$(bc <<< "($OLD_BALANCE - $NEW_BALANCE) / $GAS_PRICE")
    echo "Gas used: $GAS_USED"
}

_main "$@";

exit;

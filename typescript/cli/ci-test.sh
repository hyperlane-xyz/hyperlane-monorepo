for CHAIN in anvil1 anvil2
do
    mkdir /tmp/$CHAIN \
    /tmp/$CHAIN/state \
    /tmp/$CHAIN/validator \
    /tmp/$CHAIN/relayer && \
    chmod 777 /tmp/$CHAIN -R
done

anvil --chain-id 31337 -p 8545 --state /tmp/anvil1/state > /dev/null &
ANVIL_1_PID=$!

anvil --chain-id 31338 -p 8555 --state /tmp/anvil2/state > /dev/null &
ANVIL_2_PID=$!

sleep 1

set -e

echo "{}" > /tmp/empty-artifacts.json

echo "Deploying contracts to anvil1"
yarn workspace @hyperlane-xyz/cli run hyperlane deploy core \
    --chains ./examples/anvil-chains.yaml \
    --artifacts /tmp/empty-artifacts.json \
    --out /tmp \
    --ism ./examples/multisig-ism.yaml \
    --origin anvil1 --remotes anvil2 \
    --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    --yes

CORE_ARTIFACTS_FILE=`find /tmp/core-deployment* -type f -exec ls -t1 {} + | head -1`

echo "Deploying contracts to anvil2"
yarn workspace @hyperlane-xyz/cli run hyperlane deploy core \
    --chains ./examples/anvil-chains.yaml \
    --artifacts $CORE_ARTIFACTS_FILE \
    --out /tmp \
    --ism ./examples/multisig-ism.yaml \
    --origin anvil2 --remotes anvil1 \
    --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    --yes

CORE_ARTIFACTS_FILE=`find /tmp/core-deployment* -type f -exec ls -t1 {} + | head -1`

echo "Deploying warp routes"
yarn workspace @hyperlane-xyz/cli run hyperlane deploy warp \
    --chains ./examples/anvil-chains.yaml \
    --core $CORE_ARTIFACTS_FILE \
    --config ./examples/warp-tokens.yaml \
    --out /tmp \
    --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    --yes

echo "Sending test message"
yarn workspace @hyperlane-xyz/cli run hyperlane send message \
    --origin anvil1 \
    --destination anvil2 \
    --chains ./examples/anvil-chains.yaml \
    --core $CORE_ARTIFACTS_FILE \
    --quick \
    --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    | tee /tmp/message1

MESSAGE1_ID=`cat /tmp/message1 | grep "Message ID" | grep -oP '0x[0-9a-f]+'`
echo "Message 1 ID: $MESSAGE1_ID"

WARP_ARTIFACTS_FILE=`find /tmp/warp-deployment* -type f -exec ls -t1 {} + | head -1`
ANVIL1_ROUTER=`cat $WARP_ARTIFACTS_FILE | jq -r ".anvil1.router"`

echo "Sending test warp transfer"
yarn workspace @hyperlane-xyz/cli run hyperlane send transfer \
    --origin anvil1 \
    --destination anvil2 \
    --chains ./examples/anvil-chains.yaml \
    --core $CORE_ARTIFACTS_FILE \
    --router $ANVIL1_ROUTER \
    --type native \
    --quick \
    --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    | tee /tmp/message2

MESSAGE2_ID=`cat /tmp/message2 | grep "Message ID" | grep -oP '0x[0-9a-f]+'`
echo "Message 2 ID: $MESSAGE2_ID"

kill $ANVIL_1_PID
kill $ANVIL_2_PID

anvil --chain-id 31337 -p 8545 --block-time 1 --state /tmp/anvil1/state > /dev/null &
ANVIL_1_PID=$!

anvil --chain-id 31338 -p 8555 --block-time 1 --state /tmp/anvil2/state > /dev/null &
ANVIL_2_PID=$!

AGENT_CONFIG_FILE=`ls -t1 /tmp | grep agent-config | head -1`

for i in "anvil1 8545 ANVIL1" "anvil2 8555 ANVIL2"
do
    set -- $i
    echo "Running validator on $1"
    # Won't work on anything but linux due to -net=host
    docker run \
      --mount type=bind,source="/tmp",target=/data --net=host \
      -e CONFIG_FILES=/data/${AGENT_CONFIG_FILE} -e HYP_VALIDATOR_ORIGINCHAINNAME=$1 \
      -e HYP_VALIDATOR_REORGPERIOD=0 -e HYP_VALIDATOR_INTERVAL=1 \
      -e HYP_BASE_CHAINS_${3}_CONNECTION_URL=http://127.0.0.1:${2} \
      -e HYP_VALIDATOR_VALIDATOR_TYPE=hexKey \
      -e HYP_VALIDATOR_VALIDATOR_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 \
      -e HYP_VALIDATOR_CHECKPOINTSYNCER_TYPE=localStorage \
      -e HYP_VALIDATOR_CHECKPOINTSYNCER_PATH=/data/${1}/validator \
      -e HYP_BASE_TRACING_LEVEL=info -e HYP_BASE_TRACING_FMT=pretty \
      -log-driver none \
      gcr.io/abacus-labs-dev/hyperlane-agent:main ./validator > /dev/null 2>&1 &
done

echo "Validator running, sleeping to let it sync"
sleep 15
echo "Done sleeping"

# TODO remove, print names of all files
# find /tmp/.

# echo "Killing validator docker containers"
# docker ps -aq | xargs docker stop | xargs docker rm

echo "===Core artifacts:"
cat $CORE_ARTIFACTS_FILE 

echo "===announcement:"
cat /tmp/anvil1/validator/announcement.json


# echo "Announcing validator on anvil1"
# VALIDATOR_ANNOUNCE_ADDRESS=`cat $CORE_ARTIFACTS_FILE | jq -r ".anvil1.validatorAnnounce"`
# echo "Validator announce address: $VALIDATOR_ANNOUNCE_ADDRESS"
# VALIDATOR=`cat /tmp/anvil1/validator/announcement.json | jq -r '.value.validator'`
# echo "Validator: $VALIDATOR"
# STORAGE_LOCATION=`cat /tmp/anvil1/validator/announcement.json | jq -r '.value.storage_location'`
# echo "Storage location: $STORAGE_LOCATION"
# SIGNATURE=`cat /tmp/anvil1/validator/announcement.json | jq -r '.serialized_signature'`
# echo "Signature: $SIGNATURE"
# cast send $VALIDATOR_ANNOUNCE_ADDRESS  \
#     "announce(address, string calldata, bytes calldata)(bool)" \
#     $VALIDATOR $STORAGE_LOCATION $SIGNATURE --rpc-url http://127.0.0.1:8545 \
#     --private-key 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba

# echo "Announcing validator on anvil2"
# VALIDATOR_ANNOUNCE_ADDRESS=`cat $CORE_ARTIFACTS_FILE | jq -r ".anvil2.validatorAnnounce"`
# VALIDATOR=`cat /tmp/anvil2/validator/announcement.json | jq -r '.value.validator'`
# STORAGE_LOCATION=`cat /tmp/anvil2/validator/announcement.json | jq -r '.value.storage_location'`
# SIGNATURE=`cat /tmp/anvil2/validator/announcement.json | jq -r '.serialized_signature'`
# cast send $VALIDATOR_ANNOUNCE_ADDRESS  \
#     "announce(address, string calldata, bytes calldata)(bool)" \
#     $VALIDATOR $STORAGE_LOCATION $SIGNATURE --rpc-url http://127.0.0.1:8555 \
#     --private-key 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba

# for i in "anvil1 8545" "anvil2 8555"
# do
#     set -- $i
#     echo "Announcing validator on $1"
#     VALIDATOR_ANNOUNCE_ADDRESS=`cat $CORE_ARTIFACTS_FILE | jq -r ".$1.validatorAnnounce"`
#     VALIDATOR=`cat /tmp/$1/validator/announcement.json | jq -r '.value.validator'`
#     STORAGE_LOCATION=`cat /tmp/$1/validator/announcement.json | jq -r '.value.storage_location'`
#     SIGNATURE=`cat /tmp/$1/validator/announcement.json | jq -r '.serialized_signature'`
#     cast send $VALIDATOR_ANNOUNCE_ADDRESS  \
#       "announce(address, string calldata, bytes calldata)(bool)" \
#       $VALIDATOR $STORAGE_LOCATION $SIGNATURE --rpc-url http://127.0.0.1:$2 \
#       --private-key 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
# done

for i in "anvil1 anvil2 ANVIL2" "anvil2 anvil1 ANVIL1"
do
    set -- $i
    echo "Running relayer on $1"
    docker run \
      --mount type=bind,source="/tmp",target=/data --net=host \
      -e CONFIG_FILES=/data/${AGENT_CONFIG_FILE} \
      -e HYP_BASE_CHAINS_ANVIL1_CONNECTION_URL=http://127.0.0.1:8545 \
      -e HYP_BASE_CHAINS_ANVIL2_CONNECTION_URL=http://127.0.0.1:8555 \
      -e HYP_BASE_TRACING_LEVEL=info -e HYP_BASE_TRACING_FMT=pretty \
      -e HYP_RELAYER_ORIGINCHAINNAME=$1 -e HYP_RELAYER_DESTINATIONCHAINNAMES=$2 \
      -e HYP_RELAYER_ALLOWLOCALCHECKPOINTSYNCERS=true -e HYP_RELAYER_DB=/data/$1/relayer \
      -e HYP_RELAYER_GASPAYMENTENFORCEMENT='[{"type":"none"}]' \
      -e HYP_BASE_CHAINS_${3}_SIGNER_TYPE=hexKey \
      -e HYP_BASE_CHAINS_${3}_SIGNER_KEY=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97 \
      -log-driver none \
      gcr.io/abacus-labs-dev/hyperlane-agent:main ./relayer &
done

sleep 5
echo "Done running relayer"

docker ps -aq | xargs docker stop | xargs docker rm
kill $ANVIL_1_PID
kill $ANVIL_2_PID

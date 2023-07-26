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

for i in "anvil1 anvil2 --no-write-agent-config" "anvil2 anvil1 --write-agent-config"
do
    set -- $i
    echo "Deploying contracts to $1"
    yarn ts-node scripts/deploy-hyperlane.ts --local $1 --remotes $2 \
    --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 $3
done

echo "Deploying warp routes"
yarn ts-node scripts/deploy-warp-routes.ts \
  --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

kill $ANVIL_1_PID
kill $ANVIL_2_PID

anvil --chain-id 31337 -p 8545 --block-time 1 --state /tmp/anvil1/state > /dev/null &
ANVIL_1_PID=$!

anvil --chain-id 31338 -p 8555 --block-time 1 --state /tmp/anvil2/state > /dev/null &
ANVIL_2_PID=$!

for i in "anvil1 8545 ANVIL1" "anvil2 8555 ANVIL2"
do
    set -- $i
    echo "Running validator on $1"
    # Won't work on anything but linux due to -net=host
    docker run --mount type=bind,source="$(pwd)/artifacts",target=/config \
      --mount type=bind,source="/tmp",target=/data --net=host \
      -e CONFIG_FILES=/config/agent_config.json -e HYP_VALIDATOR_ORIGINCHAINNAME=$1 \
      -e HYP_VALIDATOR_REORGPERIOD=0 -e HYP_VALIDATOR_INTERVAL=1 \
      -e HYP_BASE_CHAINS_${3}_CONNECTION_URL=http://127.0.0.1:${2} \
      -e HYP_VALIDATOR_VALIDATOR_TYPE=hexKey \
      -e HYP_VALIDATOR_VALIDATOR_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 \
      -e HYP_VALIDATOR_CHECKPOINTSYNCER_TYPE=localStorage \
      -e HYP_VALIDATOR_CHECKPOINTSYNCER_PATH=/data/${1}/validator \
      -e HYP_BASE_TRACING_LEVEL=info -e HYP_BASE_TRACING_FMT=pretty \
      gcr.io/abacus-labs-dev/hyperlane-agent:40cc4a6-20230420-080111 ./validator &
done

sleep 10

for i in "anvil1 8545" "anvil2 8555"
do
    set -- $i
    echo "Announcing validator on $1"
    VALIDATOR_ANNOUNCE_ADDRESS=$(cat ./artifacts/addresses.json | jq -r ".$1.validatorAnnounce")
    VALIDATOR=$(cat /tmp/$1/validator/announcement.json | jq -r '.value.validator')
    STORAGE_LOCATION=$(cat /tmp/$1/validator/announcement.json | jq -r '.value.storage_location')
    SIGNATURE=$(cat /tmp/$1/validator/announcement.json | jq -r '.serialized_signature')
    cast send $VALIDATOR_ANNOUNCE_ADDRESS  \
      "announce(address, string calldata, bytes calldata)(bool)" \
      $VALIDATOR $STORAGE_LOCATION $SIGNATURE --rpc-url http://127.0.0.1:$2 \
      --private-key 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
done


for i in "anvil1 anvil2 ANVIL2" "anvil2 anvil1 ANVIL1"
do
    set -- $i
    echo "Running relayer on $1"
    docker run --mount type=bind,source="$(pwd)/artifacts",target=/config \
      --mount type=bind,source="/tmp",target=/data --net=host \
      -e CONFIG_FILES=/config/agent_config.json \
      -e HYP_BASE_CHAINS_ANVIL1_CONNECTION_URL=http://127.0.0.1:8545 \
      -e HYP_BASE_CHAINS_ANVIL2_CONNECTION_URL=http://127.0.0.1:8555 \
      -e HYP_BASE_TRACING_LEVEL=info -e HYP_BASE_TRACING_FMT=pretty \
      -e HYP_RELAYER_ORIGINCHAINNAME=$1 -e HYP_RELAYER_DESTINATIONCHAINNAMES=$2 \
      -e HYP_RELAYER_ALLOWLOCALCHECKPOINTSYNCERS=true -e HYP_RELAYER_DB=/data/$1/relayer \
      -e HYP_RELAYER_GASPAYMENTENFORCEMENT='[{"type":"none"}]' \
      -e HYP_BASE_CHAINS_${3}_SIGNER_TYPE=hexKey \
      -e HYP_BASE_CHAINS_${3}_SIGNER_KEY=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97 \
      gcr.io/abacus-labs-dev/hyperlane-agent:40cc4a6-20230420-080111 ./relayer &
done

echo "Testing message sending"
yarn ts-node scripts/test-messages.ts --chains anvil1 anvil2 \
  --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --timeout 60

echo "Sending a test warp transfer"
yarn ts-node scripts/test-warp-transfer.ts \
  --origin anvil1 --destination anvil2 --wei 1 --recipient 0xac0974bec39a17e36ba4a6b4d238ff944bacb4a5 \
  --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --timeout 60

docker ps -aq | xargs docker stop | xargs docker rm
kill $ANVIL_1_PID
kill $ANVIL_2_PID

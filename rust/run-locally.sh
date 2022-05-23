#!/bin/bash

set -e
set -u
set +x

finish () {
  rm -rf "${CHECKPOINTS_DIR?}" "${ROCKS_DB_DIR?}"
  kill -- -$$
}
trap finish SIGINT SIGTERM EXIT


DATE_STR="$(date "+%Y%m%d_%Hh%Mm%Ss")"
LOG_DIR="/tmp/logs/abacus-agents/${DATE_STR?}"
BUILD_LOG="${LOG_DIR?}/build.log"
HARDHAT_LOG="${LOG_DIR?}/hardhat.stdout.log"
RELAYER_STDOUT_LOG="${LOG_DIR?}/relayer.stdout.log"
RELAYER_STDERR_LOG="${LOG_DIR?}/relayer.stderr.log"
VALIDATOR_STDOUT_LOG="${LOG_DIR?}/validator.stdout.log"
VALIDATOR_STDERR_LOG="${LOG_DIR?}/validator.stderr.log"
KATHY_LOG="${LOG_DIR?}/kathy.stdout.log"

CHECKPOINTS_DIR=$(mktemp -d /tmp/abacus.agents.validator_sigs.XXXXXX)
ROCKS_DB_DIR=$(mktemp -d /tmp/abacus.agents.db.XXXXXX)
RELAYER_DB="${ROCKS_DB_DIR?}/relayer"
VALIDATOR_DB="${ROCKS_DB_DIR?}/validator"

function relayer {(
  export OPT_BASE_OUTBOX_CONNECTION_URL=http://localhost:8545
  export OPT_BASE_INBOXES_TEST2_CONNECTION_URL=http://localhost:8545
  export OPT_BASE_INBOXES_TEST3_CONNECTION_URL=http://localhost:8545

  export BASE_CONFIG=test1_config.json
  export RUN_ENV=test
  export OPT_BASE_METRICS=9092
  export OPT_BASE_TRACING_FMT=pretty
  export OPT_BASE_TRACING_LEVEL=info
  export OPT_BASE_DB="${RELAYER_DB?}"
  export OPT_BASE_SIGNERS_TEST1_KEY=8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61
  export OPT_BASE_SIGNERS_TEST1_TYPE=hexKey
  export OPT_BASE_SIGNERS_TEST2_KEY=f214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897
  export OPT_BASE_SIGNERS_TEST2_TYPE=hexKey
  export OPT_BASE_SIGNERS_TEST3_KEY=701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82
  export OPT_BASE_SIGNERS_TEST3_TYPE=hexKey
  export OPT_RELAYER_POLLINGINTERVAL=5
  export OPT_RELAYER_SUBMISSIONLATENCY=5
  export OPT_RELAYER_MAXRETRIES=5
  export OPT_RELAYER_RELAYERMESSAGEPROCESSING=false
  export OPT_RELAYER_MULTISIGCHECKPOINTSYNCER_THRESHOLD=1
  export OPT_RELAYER_MULTISIGCHECKPOINTSYNCER_CHECKPOINTSYNCERS_0x70997970c51812dc3a010c7d01b50e0d17dc79c8_TYPE=localStorage
  export OPT_RELAYER_MULTISIGCHECKPOINTSYNCER_CHECKPOINTSYNCERS_0x70997970c51812dc3a010c7d01b50e0d17dc79c8_PATH="${CHECKPOINTS_DIR?}"

  RUST_BACKTRACE=full cargo run --bin relayer
)}

function validator {(
  export OPT_BASE_OUTBOX_CONNECTION_URL=http://127.0.0.1:8545
  export OPT_BASE_INBOXES_TEST2_CONNECTION_URL=http://127.0.0.1:8545
  export OPT_BASE_INBOXES_TEST3_CONNECTION_URL=http://127.0.0.1:8545

  export BASE_CONFIG=test1_config.json
  export RUN_ENV=test
  export OPT_BASE_METRICS=9091
  export OPT_BASE_TRACING_FMT=pretty
  export OPT_BASE_TRACING_LEVEL=info
  export OPT_BASE_DB="${VALIDATOR_DB?}"
  export OPT_BASE_VALIDATOR_KEY=59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  export OPT_BASE_VALIDATOR_TYPE=hexKey
  export OPT_VALIDATOR_REORGPERIOD=0
  export OPT_VALIDATOR_INTERVAL=5
  export OPT_VALIDATOR_CHECKPOINTSYNCER_THRESHOLD=1
  export OPT_VALIDATOR_CHECKPOINTSYNCER_TYPE=localStorage
  export OPT_VALIDATOR_CHECKPOINTSYNCER_PATH="${CHECKPOINTS_DIR?}"

  RUST_BACKTRACE=full cargo run --bin validator
)}

mkdir -p ${LOG_DIR?}
echo "Logs in ${LOG_DIR?}"

mkdir -p ${CHECKPOINTS_DIR?} ${RELAYER_DB?} ${VALIDATOR_DB?}
echo "Signed checkpoints in ${CHECKPOINTS_DIR?}"
echo "Relayer DB in ${RELAYER_DB?}"
echo "Validator DB in ${VALIDATOR_DB?}"

echo "Building typescript..."
(cd ../typescript/infra && yarn install) > ${BUILD_LOG?}
(cd ../typescript && yarn build) >> ${BUILD_LOG?}
echo "Building relayer..." && cargo build --bin relayer >> ${BUILD_LOG?}
echo "Building validator..." && cargo build --bin validator >> ${BUILD_LOG?}

echo "Launching hardhat..."
(cd ../typescript/infra && yarn hardhat node) > ${HARDHAT_LOG?} &
while ! grep "Started HTTP" ${HARDHAT_LOG?}; do sleep 1; done

echo "Deploying abacus contracts..."
(cd ../typescript/infra && yarn abacus)
grep "Contract deployment" ${HARDHAT_LOG?} > /dev/null

echo "Spawning relayer..."
relayer > ${RELAYER_STDOUT_LOG?} 2> ${RELAYER_STDERR_LOG?} &
while ! grep -i "listening on" ${RELAYER_STDOUT_LOG?}; do sleep 1; done

echo "Spawning validator..."
validator > ${VALIDATOR_STDOUT_LOG?} 2> ${VALIDATOR_STDERR_LOG?} &
while ! grep -i "listening on" ${VALIDATOR_STDOUT_LOG?}; do sleep 1; done

echo "Setup complete! Agents running in background..."
echo "Ctrl+C to end execution..."

echo "Spawning Kathy to send Abacus message traffic..."
(cd ../typescript/infra && yarn kathy) > ${KATHY_LOG?} &
tail -f ${KATHY_LOG?} | grep "send"

# Emit any ERROR logs found in an agent's stdout
# or the presence of anything at all in stderr.
(tail -f "${RELAYER_STDOUT_LOG?}" | grep ERROR) &
(tail -f "${VALIDATOR_STDOUT_LOG?}" | grep ERROR) &
(tail -f "${RELAYER_STDERR_LOG?}") &
(tail -f "${VALIDATOR_STDERR_LOG?}") &

wait


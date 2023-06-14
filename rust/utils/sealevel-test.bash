#!/usr/bin/env bash

if [ -z $SOLAR_ECLIPSE_DIR ]; then
    echo '$SOLAR_ECLIPSE_DIR must be set'
fi

if [ -z $ECLIPSE_PROGRAM_LIBRARY_DIR ]; then
    echo '$ECLIPSE_PROGRAM_LIBRARY_DIR must be set'
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_KEYS_DIR="${SCRIPT_DIR}/../config/sealevel/test-keys"
KEYPAIR="${TEST_KEYS_DIR}/test_deployer-keypair.json"
TARGET_DIR="${SCRIPT_DIR}/../sealevel/target"
SEALEVEL_DIR="${SCRIPT_DIR}/../sealevel"
DEPLOY_DIR="${TARGET_DIR}/deploy"
BIN_DIR="${TARGET_DIR}/debug"
SPL_TOKEN="${ECLIPSE_PROGRAM_LIBRARY_DIR}/target/debug/spl-token"
CHAIN_ID="13375"
REMOTE_CHAIN_ID="13376"

# Ensure that the solar-eclipse `solana` binary is used
alias solana="${SOLAR_ECLIPSE_DIR}/target/debug/solana"

# first arg = path to .so file
# second arg = path to directory to build program in if the .so file doesn't exist
# third arg = whether to force build the program
build_program() {
    if $3 || [ ! -e $1 ]; then
        # .so file doesn't exist, build it
        pushd "${2}"
        cargo build-sbf --arch sbf
        popd
    fi
}

# first arg = path to .so file
# second arg = path to directory to build program in if the .so file doesn't exist
build_and_copy_program() {
    build_program $1 $2 $3

    # essentially cp, but -u won't copy if the source is older than the destination.
    # used as a workaround to prevent copying to the same destination as the source
    rsync -u $1 $DEPLOY_DIR
}

build_programs() {
    local force_build="${1}"

    # token programs
    build_program "${ECLIPSE_PROGRAM_LIBRARY_DIR}/target/deploy/spl_token.so" "${ECLIPSE_PROGRAM_LIBRARY_DIR}/token/program" "${force_build}"
    build_program "${ECLIPSE_PROGRAM_LIBRARY_DIR}/target/deploy/spl_token_2022.so" "${ECLIPSE_PROGRAM_LIBRARY_DIR}/token/program-2022" "${force_build}"
    build_program "${ECLIPSE_PROGRAM_LIBRARY_DIR}/target/deploy/spl_associated_token_account.so" "${ECLIPSE_PROGRAM_LIBRARY_DIR}/associated-token-account/program" "${force_build}"

    # noop
    build_program "${ECLIPSE_PROGRAM_LIBRARY_DIR}/account-compression/target/deploy/spl_noop.so" "${ECLIPSE_PROGRAM_LIBRARY_DIR}/account-compression/programs/noop" "${force_build}"

    # hyperlane sealevel programs
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_mailbox.so" "${TARGET_DIR}/../programs/mailbox" "${force_build}"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_validator_announce.so" "${TARGET_DIR}/../programs/validator-announce" "${force_build}"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_multisig_ism_message_id.so" "${TARGET_DIR}/../programs/ism/multisig-ism-message-id" "${force_build}"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_token.so" "${TARGET_DIR}/../programs/hyperlane-sealevel-token" "${force_build}"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_token_native.so" "${TARGET_DIR}/../programs/hyperlane-sealevel-token-native" "${force_build}"
}

build_spl_token_cli() {
    if [ ! -e $SPL_TOKEN ]; then
        pushd "${ECLIPSE_PROGRAM_LIBRARY_DIR}/token/cli"
        cargo build
        popd
    fi
}

setup_multisig_ism_message_id() {
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" multisig-ism-message-id set-validators-and-threshold --domain "${CHAIN_ID}" --validators 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 --threshold 1 --program-id "4RSV6iyqW9X66Xq3RDCVsKJ7hMba5uv6XP8ttgxjVUB1"
}

announce_validator() {
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" validator-announce announce --validator 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 --storage-location "file:///tmp/test_sealevel_checkpoints_0x70997970c51812dc3a010c7d01b50e0d17dc79c8" --signature "0xcd87b715cd4c2e3448be9e34204cf16376a6ba6106e147a4965e26ea946dd2ab19598140bf26f1e9e599c23f6b661553c7d89e8db22b3609068c91eb7f0fa2f01b"
}

test_token() {

    setup_multisig_ism_message_id

    announce_validator

    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" --compute-budget 200000 warp-route deploy --warp-route-name testwarproute --environment local-e2e --environments-dir "${SEALEVEL_DIR}/environments" --built-so-dir "${DEPLOY_DIR}" --token-config-file "${SEALEVEL_DIR}/environments/local-e2e/warp-routes/testwarproute/test-warp-route-token-config.json" --chain-config-file "${SEALEVEL_DIR}/environments/local-e2e/warp-routes/testwarproute/test-warp-route-chain-config.json" --ata-payer-funding-amount 1000000000

    local token_type=""
    local program_id=""

    local recipient_token_type=""
    local recipient_program_id=""

    token_type="native"
    program_id="CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga"

    recipient_token_type="synthetic"
    recipient_program_id="3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH"

    local amount=10000000000 # lamports

    local -r sender_keypair="${KEYPAIR}"
    local -r sender="$(solana -ul -k "${sender_keypair}" address)"
    local -r recipient="${sender}"

    local -r sender_balance="$(solana -ul balance "${sender}" | cut -d ' ' -f 1)"
    local -r amount_float="$(python -c "print(${amount} / 1000000000)")"
    if (( $(bc -l <<< "${sender_balance} < ${amount_float}") )); then
        echo "Insufficient sender funds"
        exit 1
    fi

    solana -ul balance "${sender}"

    # Transfer the lamports
    "${BIN_DIR}/hyperlane-sealevel-client" \
        -k "${KEYPAIR}" \
        token transfer-remote "${sender_keypair}" "${amount}" "${REMOTE_CHAIN_ID}" "${recipient}" "${token_type}" --program-id "${program_id}"

    # Wait for token transfer message to appear in the destination Mailbox.
    # This ID was manually gotten from running the Relayer and observing the logs - fragile, I know!
    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox delivered --message-id 0x7b8ba684e5ce44f898c5fa81785c83a00e32b5bef3412e648eb7a17bec497685 --program-id "9tCUWNjpqcf3NUSrtp7vquYVCwbEByvLjZUrhG5dgvhj" | grep -q 'Message not delivered'
    do
        sleep 3
    done

    solana -ul balance "${recipient}"

    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query "${token_type}" --program-id "${program_id}"
}

main() {
    if [ "${1}" = "build-only" ]; then
        build_programs true
        exit 0
    fi

    # build the client
    pushd "${SCRIPT_DIR}/../sealevel/client"
    cargo build
    popd

    # build all the required sealevel programs
    if [ "${1}" = "force-build-programs" ]; then
        build_programs true
    else
        build_programs false
    fi

    # build the SPL token CLI
    build_spl_token_cli
    # copy the keys into the deploy dir
    cp ${TEST_KEYS_DIR}/*.json ${TARGET_DIR}/deploy/

    "${BIN_DIR}/hyperlane-sealevel-client" --compute-budget 200000 -k "${KEYPAIR}" core deploy --local-domain "${CHAIN_ID}" --environment local-e2e --use-existing-keys --environments-dir "${SEALEVEL_DIR}/environments" --built-so-dir "${DEPLOY_DIR}" --chain sealeveltest1
    "${BIN_DIR}/hyperlane-sealevel-client" --compute-budget 200000 -k "${KEYPAIR}" core deploy --local-domain "${REMOTE_CHAIN_ID}" --environment local-e2e --use-existing-keys --environments-dir "${SEALEVEL_DIR}/environments" --built-so-dir "${DEPLOY_DIR}" --chain sealeveltest2

    test_token true
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    set -ex
    main "$@"
fi

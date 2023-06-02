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
DEPLOY_DIR="${TARGET_DIR}/deploy"
BIN_DIR="${TARGET_DIR}/debug"
SPL_TOKEN="${ECLIPSE_PROGRAM_LIBRARY_DIR}/target/debug/spl-token"
CHAIN_ID="13375"

# Ensure that the solar-eclipse `solana` binary is used
alias solana="${SOLAR_ECLIPSE_DIR}/target/debug/solana"

# first arg = path to .so file
# second arg = path to directory to build program in if the .so file doesn't exist
build_and_copy_program() {
    if [ ! -e $1 ]; then
        # .so file doesn't exist, build it
        pushd "${2}"
        cargo build-sbf --arch sbf
        popd
    fi

    # essentially cp, but -u won't copy if the source is older than the destination.
    # used as a workaround to prevent copying to the same destination as the source
    rsync -u $1 $DEPLOY_DIR
}

build_programs() {
    # token programs
    build_and_copy_program "${ECLIPSE_PROGRAM_LIBRARY_DIR}/target/deploy/spl_token.so" "${ECLIPSE_PROGRAM_LIBRARY_DIR}/token/program"
    build_and_copy_program "${ECLIPSE_PROGRAM_LIBRARY_DIR}/target/deploy/spl_token_2022.so" "${ECLIPSE_PROGRAM_LIBRARY_DIR}/token/program-2020"
    build_and_copy_program "${ECLIPSE_PROGRAM_LIBRARY_DIR}/target/deploy/spl_associated_token_account.so" "${ECLIPSE_PROGRAM_LIBRARY_DIR}/associated-token-account/program"

    # noop
    build_and_copy_program "${ECLIPSE_PROGRAM_LIBRARY_DIR}/account-compression/target/deploy/spl_noop.so" "${ECLIPSE_PROGRAM_LIBRARY_DIR}/account-compression/programs/noop"

    # hyperlane sealevel programs
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_mailbox.so" "${TARGET_DIR}/../programs/mailbox"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_validator_announce.so" "${TARGET_DIR}/../programs/validator-announce"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_ism_rubber_stamp.so" "${TARGET_DIR}/../programs/ism"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_token.so" "${TARGET_DIR}/../programs/hyperlane-sealevel-token"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_token_native.so" "${TARGET_DIR}/../programs/hyperlane-sealevel-token-native"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_recipient_echo.so" "${TARGET_DIR}/../programs/recipient"
}

build_spl_token_cli() {
    if [ ! -e $SPL_TOKEN ]; then
        pushd "${ECLIPSE_PROGRAM_LIBRARY_DIR}/token/cli"
        cargo build
        popd
    fi
}

announce_validator() {
    set +e
    # init the validator announce contract
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" validator-announce init

    # announce the validator
    # This may fail until the previous init command reaches finality,
    # just retry till it succeeds
    while ! "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" validator-announce announce --validator 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 --storage-location "file:///tmp/test_sealevel_checkpoints_0x70997970c51812dc3a010c7d01b50e0d17dc79c8" --signature "0xcd87b715cd4c2e3448be9e34204cf16376a6ba6106e147a4965e26ea946dd2ab19598140bf26f1e9e599c23f6b661553c7d89e8db22b3609068c91eb7f0fa2f01b"; do
        sleep 3
    done

    set -e
}

mailbox_init() {
    set +e
    while ! "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox init; do
        sleep 3
    done

    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query | grep -q 'Not yet created'; do
        sleep 3
    done
    set -e
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query

    announce_validator
}

test_mailbox() {
    mailbox_init

    # Send N test messages to the outbox to be validated anmailbox d relayed to the inbox.
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
}

token_init() {
    local -r token_type="${1}"
    local -r program_id="${2}"

    set +e
    while ! "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token init "${token_type}" --program-id "${program_id}"; do
        sleep 3
    done

    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query "${token_type}" --program-id "${program_id}" | grep -q 'Not yet created'; do
        sleep 3
    done
    set -e
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query "${token_type}" --program-id "${program_id}"
}

test_token() {
    local -r is_native_xfer="${1}"

    mailbox_init

    local token_type=""
    local program_id=""
    local hex_program_id=""

    local recipient_token_type=""
    local recipient_program_id=""
    local recipient_hex_program_id=""

    if "${is_native_xfer}"; then
        token_type="native"
        program_id="CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga"
        # Hex representation of program_id
        hex_program_id="0xa77b4e2ed231894cc8cb8eee21adcc705d8489bccc6b2fcf40a358de23e60b7b"

        recipient_token_type="synthetic"
        recipient_program_id="3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH"
        # Hex representation of recipient_program_id
        recipient_hex_program_id="0x2317f9615d4ebc2419ad4b88580e2a80a03b2c7a60bc960de7d6934dbc37a87e"
    else
        token_type="synthetic"
        program_id="3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH"
        # Hex representation of program_id
        hex_program_id="0x2317f9615d4ebc2419ad4b88580e2a80a03b2c7a60bc960de7d6934dbc37a87e"

        recipient_token_type="native"
        recipient_program_id="CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga"
        # Hex representation of recipient_program_id
        recipient_hex_program_id="0xa77b4e2ed231894cc8cb8eee21adcc705d8489bccc6b2fcf40a358de23e60b7b"
    fi
    
    # Init origin side & enroll the remote router
    token_init "${token_type}" "${program_id}"
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token enroll-remote-router $CHAIN_ID "${recipient_hex_program_id}" --program-id "${program_id}"

    # Init destination side & enroll the remote router
    token_init "${recipient_token_type}" "${recipient_program_id}"
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token enroll-remote-router $CHAIN_ID "${hex_program_id}" --program-id "${recipient_program_id}"

    local amount
    if "${is_native_xfer}"; then
        amount=10000000000 # lamports
    else
        amount=10
    fi
    local -r sender_keypair="${KEYPAIR}"
    local -r sender="$(solana -ul -k "${sender_keypair}" address)"
    # FIXME don't hardcode associated token account
    local -r sender_ata="BuzmX6KEGVvJpR2k28SRa5epPRm9FWpq3KiHe4XFbcHN"
    local -r recipient="${sender}"
    local -r recipient_ata="${sender_ata}"

    if "${is_native_xfer}"; then
        local -r sender_balance="$(solana -ul balance "${sender}" | cut -d ' ' -f 1)"
        local -r amount_float="$(python -c "print(${amount} / 1000000000)")"
        if (( $(bc -l <<< "${sender_balance} < ${amount_float}") )); then
            echo "Insufficient sender funds"
            exit 1
        fi

        echo
        echo
        solana -ul balance "${sender}"

        # Initiate loopback transfer.
        "${BIN_DIR}/hyperlane-sealevel-client" \
            -k "${KEYPAIR}" \
            token transfer-remote "${sender_keypair}" "${amount}" "${CHAIN_ID}" "${recipient}" "${token_type}" --program-id "${program_id}"
    else
        # Load the sender account with tokens.
        # TODO: Note that this will not work if the mailbox auth account is required to be a signer
        # which it should be when the contract is deployed in prod.
        "${BIN_DIR}/hyperlane-sealevel-client" \
            -k "${KEYPAIR}" \
            token transfer-from-remote "${CHAIN_ID}" "${sender}" "${amount}" "${token_type}" --program-id "${program_id}"

        sleep 20 # FIXME shouldn't need this sleep but idk why things are broken if the balance is queried
        while "${SPL_TOKEN}" -ul display "${sender_ata}" | grep -q 'Balance: 0'; do
            sleep 3
        done
        echo
        echo
        "${SPL_TOKEN}" -ul display "${sender_ata}"

        # Initiate loopback transfer.
        "${BIN_DIR}/hyperlane-sealevel-client" \
            -k "${KEYPAIR}" \
            token transfer-remote "${sender_keypair}" "${amount}" "${CHAIN_ID}" "${recipient}" "${token_type}" --program-id "${program_id}"
    fi

    # Wait for token transfer message to appear in outbox.
    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query | grep -q 'count: 0'
    do
        sleep 3
    done
    echo
    echo
    if "${is_native_xfer}"; then
        solana -ul balance "${sender}"
    else
        "${SPL_TOKEN}" -ul display "${sender_ata}"
    fi
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query "${token_type}" --program-id "${program_id}"

    # Wait for token transfer message to appear in inbox.
    # This ID was manually gotten from running the Relayer and observing the logs - fragile, I know!
    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox delivered --message-id 0x0f2c21e554389e78a88b8d198f5a33b35b66a7fe0e59be82d352fff83a5c9764 | grep -q 'Message not delivered'
    do
        sleep 3
    done
    echo
    echo
    if "${is_native_xfer}"; then
        solana -ul balance "${recipient}"
    else
        "${SPL_TOKEN}" -ul display "${recipient_ata}"
    fi
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query "${token_type}" --program-id "${program_id}"
}

main() {
    # build the client
    pushd "${SCRIPT_DIR}/../sealevel/client"
    cargo build
    popd

    # build all the required sealevel programs
    build_programs
    # build the SPL token CLI
    build_spl_token_cli
    # copy the keys into the deploy dir
    cp ${TEST_KEYS_DIR}/*.json ${TARGET_DIR}/deploy/

    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/spl_noop.so"
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/spl_token.so"
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/spl_token_2022.so"
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/spl_associated_token_account.so"

    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_token.so"
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_token_native.so"
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_mailbox.so"
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_validator_announce.so"
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_recipient_echo.so"
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_ism_rubber_stamp.so"

    case "${1}" in
        "mailbox")
            test_mailbox
            ;;
        "token-native")
            test_token true
            ;;
        "token-wrapped")
            test_token false
            ;;
        *)
            echo "[mailbox | token-native | token-wrapped]"
            exit 1
            ;;
    esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    set -ex
    main "$@"
fi

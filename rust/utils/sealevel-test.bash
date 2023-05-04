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
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_ism_rubber_stamp.so" "${TARGET_DIR}/../programs/ism"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_token.so" "${TARGET_DIR}/../programs/hyperlane-sealevel-token"
    build_and_copy_program "${TARGET_DIR}/deploy/hyperlane_sealevel_recipient_echo.so" "${TARGET_DIR}/../programs/recipient"
}

build_spl_token_cli() {
    if [ ! -e $SPL_TOKEN ]; then
        pushd "${ECLIPSE_PROGRAM_LIBRARY_DIR}/token/cli"
        cargo build
        popd
    fi
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
}

test_mailbox() {
    mailbox_init

    # Send N test messages to the outbox to be validated anmailbox d relayed to the inbox.
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
}

token_init() {
    set +e
    while ! "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token init; do
        sleep 3
    done

    while ! "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token init-erc20; do
        sleep 3
    done

    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query | grep -q 'Not yet created'; do
        sleep 3
    done
    set -e
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query
}

test_token() {
    local -r is_native_xfer="${1}"

    mailbox_init
    token_init

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
            token transfer-remote "${sender_keypair}" "${amount}" "${CHAIN_ID}" "${recipient}" \
            --name "MOON" --symbol "$"
    else
        # Load the sender account with tokens.
        # TODO: Note that this will not work if the mailbox auth account is required to be a signer
        # which it should be when the contract is deployed in prod.
        "${BIN_DIR}/hyperlane-sealevel-client" \
            -k "${KEYPAIR}" \
            token transfer-from-remote "${CHAIN_ID}" "${sender}" "${amount}"

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
            token transfer-remote "${sender_keypair}" "${amount}" "${CHAIN_ID}" "${recipient}"
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
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query

    # Wait for token transfer message to appear in inbox.
    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query | grep -q 'delivered: {}'
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
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query
}

main() {
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
    solana -ul -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_mailbox.so"
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

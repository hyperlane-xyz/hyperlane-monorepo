#!/usr/bin/env bash

SCRIPT_DIR="$(realpath "$(dirname "${BASH_SOURCE[0]}")")"
KEYPAIR="${HOME}/.config/eclipse/id.json"
TARGET_DIR="${SCRIPT_DIR}/../sealevel/target"
DEPLOY_DIR="${TARGET_DIR}/deploy"
BIN_DIR="${TARGET_DIR}/debug"
SPL_TOKEN="${HOME}/code/eclipse-labs/eclipse-program-library/target/debug/spl-token"
CHAIN_ID="13375"

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

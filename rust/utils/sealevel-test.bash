#!/usr/bin/env bash

SCRIPT_DIR="$(realpath "$(dirname "${BASH_SOURCE[0]}")")"
KEYPAIR="${HOME}/.config/eclipse/id.json"
TARGET_DIR="${SCRIPT_DIR}/../sealevel/target"
DEPLOY_DIR="${TARGET_DIR}/deploy"
BIN_DIR="${TARGET_DIR}/debug"
SPL_TOKEN="${HOME}/code/eclipse-labs/eclipse-program-library/target/debug/spl-token"
CHAIN_ID="13375"

test_mailbox() {
    set +e
    while ! "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox init; do
        sleep 3
    done

    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query | grep -q 'Not yet created'; do
        sleep 3
    done
    set -e
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox query

    # Send N test messages to the outbox to be validated anmailbox d relayed to the inbox.
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" mailbox send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
}

test_token() {
    set +e
    while ! "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token init; do
        sleep 3
    done

    while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query | grep -q 'Not yet created'; do
        sleep 3
    done
    set -e
    "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" token query

    local mint_amount=10
    local -r recipient="$(solana -ul -k "${KEYPAIR}" address)"
    "${BIN_DIR}/hyperlane-sealevel-client" \
        -k "${KEYPAIR}" \
        token transfer-to "${recipient}" "${mint_amount}"
    sleep 20 # FIXME shouldn't need this sleep but idk why things are broken if the balance is queried
    # FIXME don't hardcode associated token account
    local -r ata="HKLeaDnBs4gu2TX7C8T2Z5NnTh6aKyMEp9UZ6kZYizjs"
    while "${SPL_TOKEN}" -ul display "${ata}" | grep -q 'Balance: 0'; do
        sleep 3
    done
    "${SPL_TOKEN}" -ul display "${ata}"

    local -r burn_amount=5
    "${BIN_DIR}/hyperlane-sealevel-client" \
        -k "${KEYPAIR}" \
        token transfer-from-sender "${KEYPAIR}" "${burn_amount}"
    while "${SPL_TOKEN}" -ul display "${ata}" | grep -q "Balance: ${mint_amount}"; do
        sleep 3
    done
    "${SPL_TOKEN}" -ul display "${ata}"
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
        "token")
            test_token
            ;;
        *)
            echo "mailbox or token?"
            exit 1
            ;;
    esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    set -ex
    main "$@"
fi

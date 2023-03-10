#!/usr/bin/env bash
set -ex

KEYPAIR="${HOME}/.config/eclipse/id.json"
TARGET_DIR="../sealevel/target"
DEPLOY_DIR="${TARGET_DIR}/deploy"
BIN_DIR="${TARGET_DIR}/debug"
CHAIN_ID="13375"

solana -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_mailbox.so"
solana -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_recipient_echo.so"
solana -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/hyperlane_sealevel_ism_rubber_stamp.so"
solana -k "${KEYPAIR}" program deploy "${DEPLOY_DIR}/spl_noop.so"

set +e
while ! "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" init; do
    sleep 3
done

while "${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" query | grep -q 'Not yet created'; do
    sleep 3
done
set -e
"${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" query

# Send N test messages to the outbox to be validated and relayed to the inbox.
"${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
"${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" send -l "${CHAIN_ID}" -d "${CHAIN_ID}"
"${BIN_DIR}/hyperlane-sealevel-client" -k "${KEYPAIR}" send -l "${CHAIN_ID}" -d "${CHAIN_ID}"

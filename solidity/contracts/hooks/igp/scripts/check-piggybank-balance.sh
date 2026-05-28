#!/bin/bash
# PiggyBank Sponsor IGP - Low Balance Monitor
#
# This script checks the sponsor balance of a PiggyBankSponsorIGP contract
# and alerts when it falls below a threshold.
#
# Usage:
#   ./check-piggybank-balance.sh <RPC_URL> <CONTRACT_ADDRESS> [THRESHOLD_WEI]
#
# Example:
#   ./check-piggybank-balance.sh https://eth-mainnet.g.alchemy.com/v2/KEY 0x1234... 1000000000000000000
#
# Set alert webhook URL in env var:
#   export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
#   export TELEGRAM_BOT_TOKEN="..."
#   export TELEGRAM_CHAT_ID="..."
#
# Run via cron every hour:
#   0 * * * * /path/to/check-piggybank-balance.sh https://rpc.url 0xContract 1000000000000000000

set -euo pipefail

RPC_URL="${1:?Usage: $0 <RPC_URL> <CONTRACT_ADDRESS> [THRESHOLD_WEI]}"
CONTRACT="${2:?Usage: $0 <RPC_URL> <CONTRACT_ADDRESS> [THRESHOLD_WEI]}"
THRESHOLD="${3:-1000000000000000000}" # Default: 1 ETH

# ERC-20 ABI for balanceOf (PiggyBank uses sponsorBalance())
SPONSOR_BALANCE_SIG="0x8b3afd60" # keccak256("sponsorBalance()") first 4 bytes
SPONSOR_SIG="0x8f32be59" # keccak256("sponsor()") first 4 bytes
LOW_BALANCE_THRESHOLD_SIG="0xbdccf01a" # keccak256("lowBalanceThreshold()") first 4 bytes

echo "=== PiggyBank Sponsor IGP Balance Check ==="
echo "Contract: $CONTRACT"
echo "RPC: $RPC_URL"
echo "Threshold: $THRESHOLD wei"
echo ""

# Get sponsor address
SPONSOR=$(cast call --rpc-url "$RPC_URL" "$CONTRACT" "$SPONSOR_SIG" 2>/dev/null || echo "N/A")
echo "Sponsor: $SPONSOR"

# Get current balance
BALANCE_HEX=$(cast call --rpc-url "$RPC_URL" "$CONTRACT" "$SPONSOR_BALANCE_SIG" 2>/dev/null || echo "0x0")
BALANCE=$(cast to-dec "$BALANCE_HEX" 2>/dev/null || echo "0")

# Get configured threshold
CONFIGURED_THRESHOLD_HEX=$(cast call --rpc-url "$RPC_URL" "$CONTRACT" "$LOW_BALANCE_THRESHOLD_SIG" 2>/dev/null || echo "0x0")
CONFIGURED_THRESHOLD=$(cast to-dec "$CONFIGURED_THRESHOLD_HEX" 2>/dev/null || echo "0")

echo "Balance: $(echo "scale=4; $BALANCE / 10^18" | bc) ETH ($BALANCE wei)"
echo "Configured threshold: $(echo "scale=4; $CONFIGURED_THRESHOLD / 10^18" | bc) ETH"
echo "Alert threshold: $(echo "scale=4; $THRESHOLD / 10^18" | bc) ETH"
echo ""

if [ "$BALANCE" -lt "$THRESHOLD" ]; then
    echo "⚠️  WARNING: Balance is BELOW threshold!"
    
    BALANCE_ETH=$(echo "scale=4; $BALANCE / 10^18" | bc)
    THRESHOLD_ETH=$(echo "scale=4; $THRESHOLD / 10^18" | bc)
    MESSAGE="🚨 PiggyBank IGP Low Balance Alert
Contract: $CONTRACT
Sponsor: $SPONSOR
Current Balance: ${BALANCE_ETH} ETH
Threshold: ${THRESHOLD_ETH} ETH
Action Required: Please deposit more funds to prevent service disruption."

    # Send alert via Slack webhook
    if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
        curl -s -X POST -H "Content-Type: application/json" \
            -d "{\"text\": \"$MESSAGE\"}" \
            "$SLACK_WEBHOOK_URL"
        echo "Slack alert sent."
    fi

    # Send alert via Telegram
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
        curl -s -X POST \
            "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d "chat_id=${TELEGRAM_CHAT_ID}&text=${MESSAGE}&parse_mode=Markdown"
        echo "Telegram alert sent."
    fi

    # Send alert via email (using mail command)
    if [ -n "${ALERT_EMAIL:-}" ]; then
        echo "$MESSAGE" | mail -s "PiggyBank IGP Low Balance Alert" "$ALERT_EMAIL"
        echo "Email alert sent to $ALERT_EMAIL."
    fi

    echo ""
    echo "=== ALERT TRIGGERED ==="
    exit 1
else
    echo "✓ Balance is healthy (above threshold)."
    echo "=== OK ==="
    exit 0
fi

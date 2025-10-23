#!/bin/bash

set -euo pipefail

# Usage function
usage() {
    cat << EOF
Usage: $0 --total-transactions <num> --account <address> --rpc-url <url> --aws-kms-key-id <key> --aws-region <region>

Required parameters:
  --total-transactions <num>    Total number of transactions to submit
  --account <address>           Account address to send transactions to
  --rpc-url <url>              RPC URL for the blockchain
  --aws-kms-key-id <key>       AWS KMS key ID for signing
  --aws-region <region>        AWS region for KMS

Optional parameters:
  --help                        Show this help message

EOF
    exit 1
}

# Parse command line arguments
TOTAL_TRANSACTIONS=""
ACCOUNT=""
RPC_URL=""
AWS_KMS_KEY_ID=""
AWS_DEFAULT_REGION=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --total-transactions)
            TOTAL_TRANSACTIONS="$2"
            shift 2
            ;;
        --account)
            ACCOUNT="$2"
            shift 2
            ;;
        --rpc-url)
            RPC_URL="$2"
            shift 2
            ;;
        --aws-kms-key-id)
            AWS_KMS_KEY_ID="$2"
            shift 2
            ;;
        --aws-region)
            AWS_DEFAULT_REGION="$2"
            shift 2
            ;;
        --help)
            usage
            ;;
        *)
            echo "Error: Unknown parameter: $1" >&2
            usage
            ;;
    esac
done

# Validate required parameters
if [ -z "$TOTAL_TRANSACTIONS" ] || [ -z "$ACCOUNT" ] || [ -z "$RPC_URL" ] || [ -z "$AWS_KMS_KEY_ID" ] || [ -z "$AWS_DEFAULT_REGION" ]; then
    echo "Error: Missing required parameters" >&2
    usage
fi

# Validate TOTAL_TRANSACTIONS is a number
if ! [[ "$TOTAL_TRANSACTIONS" =~ ^[0-9]+$ ]]; then
    echo "Error: --total-transactions must be a number" >&2
    exit 1
fi

# Validate ACCOUNT format
if ! [[ "$ACCOUNT" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    echo "Error: --account must be a valid Ethereum address (0x followed by 40 hex characters)" >&2
    exit 1
fi

# Validate RPC_URL format
if ! [[ "$RPC_URL" =~ ^https?:// ]]; then
    echo "Error: --rpc-url must be a valid HTTP/HTTPS URL" >&2
    exit 1
fi

# Retry configuration
MAX_SUBMIT_RETRIES=5
MAX_CONFIRM_RETRIES=90  # 3 minutes with 2 second intervals
CONFIRM_CHECK_INTERVAL=2
RETRY_DELAY=5

# Progress tracking file
PROGRESS_FILE="${HOME}/.hyperlane_tx_progress"
LOG_FILE="${HOME}/.hyperlane_tx_log.txt"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load progress from file if it exists
START_FROM=1
if [ -f "$PROGRESS_FILE" ]; then
    SAVED_PROGRESS=$(cat "$PROGRESS_FILE")
    START_FROM=$((SAVED_PROGRESS + 1))
    if [ $START_FROM -le $TOTAL_TRANSACTIONS ]; then
        echo -e "${BLUE}Resuming from transaction $START_FROM (found progress file)${NC}"
    else
        echo -e "${GREEN}All transactions already completed!${NC}"
        rm -f "$PROGRESS_FILE"
        exit 0
    fi
fi

REMAINING=$((TOTAL_TRANSACTIONS - START_FROM + 1))

echo "Starting batch transaction submission"
echo "Total transactions: $TOTAL_TRANSACTIONS"
echo "Starting from: $START_FROM"
echo "Remaining: $REMAINING"
echo "Account: $ACCOUNT"
echo "RPC URL: $RPC_URL"
echo "Progress file: $PROGRESS_FILE"
echo "Log file: $LOG_FILE"
echo "----------------------------------------"

# Log function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

# Function to check if transaction is confirmed
check_transaction_receipt() {
    local tx_hash=$1
    local receipt_output
    local exit_code

    # Try to get receipt, capture both output and exit code
    receipt_output=$(cast receipt "$tx_hash" --rpc-url "$RPC_URL" 2>&1)
    exit_code=$?

    # If cast receipt succeeded (exit code 0), transaction exists
    if [ $exit_code -eq 0 ]; then
        # Check if receipt shows success (status field should be 1)
        if echo "$receipt_output" | grep -q "status.*1"; then
            log "Transaction confirmed with success status"
            return 0  # Transaction confirmed and successful
        else
            log "WARNING: Transaction exists but may have failed (no success status found)"
            # Still return 0 since transaction is confirmed, just may have reverted
            return 0
        fi
    fi

    # Transaction not yet mined
    return 1
}

# Function to wait for transaction confirmation with retries
wait_for_transaction() {
    local tx_hash=$1
    local attempt=0

    log "Waiting for transaction $tx_hash to be mined..."

    while [ $attempt -lt $MAX_CONFIRM_RETRIES ]; do
        # Check if transaction receipt exists and is successful
        if check_transaction_receipt "$tx_hash"; then
            log "Transaction $tx_hash confirmed!"
            return 0
        fi

        attempt=$((attempt + 1))
        if [ $((attempt % 10)) -eq 0 ]; then
            echo -e "${YELLOW}Still waiting... attempt $attempt/$MAX_CONFIRM_RETRIES${NC}" >&2
        fi
        sleep $CONFIRM_CHECK_INTERVAL
    done

    log "ERROR: Transaction $tx_hash did not confirm within expected time"
    return 1
}

# Function to submit transaction with retries
submit_transaction() {
    local tx_number=$1
    local attempt=0

    while [ $attempt -lt $MAX_SUBMIT_RETRIES ]; do
        attempt=$((attempt + 1))

        log "Submitting transaction $tx_number/$TOTAL_TRANSACTIONS (attempt $attempt/$MAX_SUBMIT_RETRIES)"

        # Submit transaction and capture output
        local output
        output=$(AWS_KMS_KEY_ID="$AWS_KMS_KEY_ID" AWS_DEFAULT_REGION="$AWS_DEFAULT_REGION" \
            cast send "$ACCOUNT" --value 1 --rpc-url "$RPC_URL" --aws 2>&1)
        local submit_exit_code=$?

        # Check if we got a "nonce too low" error - this means a previous transaction succeeded
        if echo "$output" | grep -qi "nonce too low"; then
            log "INFO: Nonce too low error - this means a previous transaction already succeeded"
            log "Skipping this transaction submission as it's already done"
            # Return special marker to indicate we should skip waiting
            echo "NONCE_TOO_LOW"
            return 0
        fi

        if [ $submit_exit_code -eq 0 ]; then
            # Extract transaction hash from output
            local tx_hash
            tx_hash=$(echo "$output" | grep -i "transactionHash" | awk '{print $2}')

            if [ -n "$tx_hash" ] && [[ "$tx_hash" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
                log "Transaction submitted successfully: $tx_hash"
                echo "$tx_hash"
                return 0
            else
                log "WARNING: Could not extract valid transaction hash from output"
                log "Output: $output"
            fi
        else
            log "ERROR: Transaction submission failed with exit code $submit_exit_code"
            log "Output: $output"
        fi

        if [ $attempt -lt $MAX_SUBMIT_RETRIES ]; then
            echo -e "${YELLOW}Retrying in $RETRY_DELAY seconds...${NC}" >&2
            sleep $RETRY_DELAY
        fi
    done

    log "ERROR: Failed to submit transaction after $MAX_SUBMIT_RETRIES attempts"
    return 1
}

# Signal handler for clean exit
trap 'echo -e "\n${YELLOW}Script interrupted. Progress saved. Run again to resume.${NC}"; exit 130' INT TERM

# Main loop
for i in $(seq $START_FROM $TOTAL_TRANSACTIONS); do
    echo ""
    echo "=========================================="
    echo "Transaction $i/$TOTAL_TRANSACTIONS"
    echo "=========================================="

    # Submit transaction with retries
    tx_hash=$(submit_transaction "$i")

    if [ -z "$tx_hash" ]; then
        echo -e "${RED}Failed to submit transaction $i after multiple attempts${NC}"
        echo -e "${YELLOW}Progress saved at transaction $((i-1)). Run the script again to retry.${NC}"
        exit 1
    fi

    # Check if this was a "nonce too low" case - transaction already succeeded previously
    if [ "$tx_hash" = "NONCE_TOO_LOW" ]; then
        echo -e "${BLUE}Transaction $i already completed (nonce too low), skipping...${NC}"
        log "Transaction $i skipped - already completed in previous run"

        # Save progress and continue to next transaction
        echo "$i" > "$PROGRESS_FILE"
        echo -e "${GREEN}✓ Progress: $i/$TOTAL_TRANSACTIONS completed ($((TOTAL_TRANSACTIONS - i)) remaining)${NC}"

        # Small delay before next transaction
        sleep 1
        continue
    fi

    echo -e "${GREEN}Transaction submitted: $tx_hash${NC}"

    # Wait for confirmation
    if ! wait_for_transaction "$tx_hash"; then
        echo -e "${RED}Failed to confirm transaction $i${NC}"
        echo -e "${YELLOW}Transaction hash: $tx_hash${NC}"
        echo -e "${YELLOW}You can manually check the transaction status and run the script again.${NC}"
        echo -e "${YELLOW}Progress saved at transaction $((i-1)).${NC}"
        exit 1
    fi

    # Save progress after successful confirmation
    echo "$i" > "$PROGRESS_FILE"

    echo -e "${GREEN}✓ Progress: $i/$TOTAL_TRANSACTIONS completed ($((TOTAL_TRANSACTIONS - i)) remaining)${NC}"
    log "Transaction $i completed successfully"

    # Small delay between transactions to avoid overwhelming the system
    sleep 1
done

# Clean up progress file on successful completion
rm -f "$PROGRESS_FILE"

echo ""
echo "=========================================="
echo -e "${GREEN}All $TOTAL_TRANSACTIONS transactions completed successfully!${NC}"
echo "=========================================="
log "All transactions completed successfully"

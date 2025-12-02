#!/bin/bash

HELP_MESSAGE="Script to check merkle root consistency between relayer and validator
Usage: $0 --chain-name <chain_name> --domain-id <domain_id> --leaf-index-start <number>

    --help -h               show help menu
    --chain-name            the name of the chain
    --domain-id             the domain id of the chain
    --leaf-index-start      the leaf index to start at and go forward"

set -e

# Function to extract message_id from checkpoint response
extract_checkpoint_merkle_root() {
    echo "$1" | jq -r '.value.checkpoint.root' 2>/dev/null
}

# Function to extract message_id from merkle insertions response
extract_relayer_merkle_root() {
    echo "$1" | jq -r '.root' 2>/dev/null
}

# Function to pretty print JSON
pretty_print_json() {
    if command -v jq &> /dev/null; then
        echo "$1" | jq '.'
    else
        echo "$1"
    fi
}

main() {
    chain=$1
    domain_id=$2
    start_index=$3

    mismatch_found=false
    current_index=$start_index

    url="https://hyperlane-mainnet3-${chain}-validator-0.s3.us-east-1.amazonaws.com"

    echo "Starting comparison from index $start_index..."
    echo "==============================================="

    while [ "$mismatch_found" = false ]; do
        echo "Checking index $current_index..."

        # Fetch from checkpoint endpoint
        checkpoint_url="$url/checkpoint_${current_index}_with_id.json"
        echo -e "\n🌐 API Call: GET $checkpoint_url"
        checkpoint_response=$(curl -s "$checkpoint_url")
        echo "📥 Response size: $(echo "$checkpoint_response" | wc -c) bytes"

        # Debug: Print the relevant part of the response
        echo "🔍 Debugging checkpoint response:"
        echo "$checkpoint_response"

        checkpoint_root=$(extract_checkpoint_merkle_root "$checkpoint_response")

        # Check if checkpoint request was successful
        if [[ -n "$checkpoint_root" && "$checkpoint_root" != "null" ]]; then
            checkpoint_root=$(extract_checkpoint_merkle_root "$checkpoint_response")
            echo "📋 Extracted checkpoint root: $checkpoint_root"

            # Fetch from merkle insertions endpoint
            merkle_url="http://0.0.0.0:9090/merkle_proofs?domain_id=${domain_id}&leaf_index=${current_index}&root_index=${current_index}"
            echo -e "\n🌐 API Call: GET $merkle_url"
            merkle_response=$(curl -s "$merkle_url")
            response_status_code=$?

            # Debug: Print the relevant part of the response

            # Check if merkle request was successful
            if [ $response_status_code -eq 0 ]; then
                extracted_merkle_root=$(extract_relayer_merkle_root "$merkle_response")
                merkle_root="0x${extracted_merkle_root}"
                echo "📋 Extracted merkle message_id: $merkle_root"

                echo -e "\n📊 Comparison for index $current_index:"
                echo "  Checkpoint root: $checkpoint_root"
                echo "  Merkle root:     $merkle_root"

                # Compare the message IDs
                if [ "$checkpoint_root" != "$merkle_root" ]; then
                    echo -e "\n⚠️ MISMATCH FOUND at index $current_index:"
                    echo "  Checkpoint: $checkpoint_root"
                    echo "  Merkle:     $merkle_root"
                    mismatch_found=true
                else
                    echo "  ✓ Match"
                    echo "==============================================="
                    current_index=$((current_index + 1))
                fi
            else
                echo -e "\n❌ Error: Failed to parse merkle data for index $current_index"
                echo "Raw response:"
                pretty_print_json "$merkle_response"
                exit 1
            fi
        else
            echo -e "\n❌ Error: Failed to parse checkpoint data for index $current_index"
            echo "Raw response:"
            pretty_print_json "$checkpoint_response"
            exit 1
        fi
    done

    echo -e "\n✅ Comparison complete. First mismatch found at index $current_index."

}

## Start of execution

while [ "$#" -gt 0 ]; do
    case "$1" in
        "-h")
            ;&
        "--help")
            echo "$HELP_MESSAGE" >&2
            exit 0
            ;;
        "--chain-name")
            shift
            chain_name="$1"
            ;;
        "--domain-id")
            shift
            domain_id="$1"
            ;;
        "--leaf-index-start")
            shift
            leaf_index_start="$1"
            ;;
        *)
            echo "Unknown argument $1. Run -h for usage" >&2
            exit 1
            ;;
    esac
    shift
done

if [ -z "$chain_name" ]; then
    echo "$0: Error: Chain name not provided. Run -h for usage" >&2
    exit 1
fi
if [ -z "$domain_id" ]; then
    echo "$0: Error: Domain id not provided. Run -h for usage" >&2
    exit 1
fi
if [ -z "$leaf_index_start" ]; then
    echo "$0: Error: Leaf index start not provided. Run -h for usage" >&2
    exit 1
fi

main "$chain_name" "$domain_id" "$leaf_index_start"

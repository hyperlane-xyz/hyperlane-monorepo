#!/bin/bash

HELP_MESSAGE="Script that goes backwards and compares on-chain merkle tree data with posted validator checkpoints.
Usage: $0 --rpc-url <rpc_url> --merkle-hook-address <merkle_hook_address> --chain-name <chain> --start-block <block_start>

    --help -h               show help menu
    --rpc-url               specifies the RPC URL to use
    --merkle-hook-address   the merkle hook address to get logs for
    --chain-name            the name of the chain
    --start-block           the block to start at and go backwards"

set -e

# Function to extract message_id from checkpoint response
extract_checkpoint_message_id() {
    echo "$1" | jq -r '.value.message_id' 2>/dev/null || echo "$1" | grep -o '"value":{[^}]*"message_id":"[^"]*"' | grep -o '"message_id":"[^"]*"' | cut -d'"' -f4
}

# Function to pretty print JSON
pretty_print_json() {
    if command -v jq &> /dev/null; then
        echo "$1" | jq '.'
    else
        echo "$1"
    fi
}

fetch_merkle_tree_events() {
    rpc_url=$1
    address=$2
    from_block=$3
    to_block=$4

    from_block_hex=$(printf '0x%x' $from_block)
    to_block_hex=$(printf '0x%x' $to_block)

    curl -sS --fail --max-time 20 "$rpc_url" \
        -X POST \
        -H "Content-Type: application/json" \
        --data '{
            "method":"eth_getLogs",
            "params":[
                {
                    "fromBlock": "'$from_block_hex'",
                    "toBlock": "'$to_block_hex'",
                    "address": "'$address'"
                }
            ],
            "id":1,"jsonrpc":"2.0"}'
}

fetch_validator_checkpoint() {
    leaf_index=$1
    # Fetch from checkpoint endpoint
    checkpoint_url="$validator_url/checkpoint_${leaf_index}_with_id.json"
    curl -sS --fail --max-time 20 "$checkpoint_url"
}

main() {
    rpc_url=$1
    address=$2
    chain=$3
    block_start=$4

    mismatch_found=false

    batch_size=800
    to_block=$block_start
    from_block=$to_block

    event_name='InsertedIntoTree(bytes32,uint32)'
    event_signature='0x253a3a04cab70d47c1504809242d9350cd81627b4f1d50753e159cf8cd76ed33'

    echo "Starting comparison from block $block_start..."
    echo "==============================================="

    validator_url="https://hyperlane-mainnet3-${chain}-validator-0.s3.us-east-1.amazonaws.com"

    while [ "$mismatch_found" = false ]; do
        [ "$to_block" -le 0 ] && break
        to_block=$from_block
        from_block=$(( $to_block - $batch_size ))

        echo "Fetching logs $from_block .. $to_block"
        events=$(fetch_merkle_tree_events $rpc_url $address $from_block $to_block | jq .result)

        # echo "$events"
        event_count=$(echo "$events" | jq -r length)
        if [ $event_count -eq 0 ]; then
            continue
        fi

        for ((i=0; i<event_count; i++)); do
            event=$(echo "$events" | jq -r ".[$i]")
            [ "$event" = "null" ] && continue
            event_sig=$(echo "$event" | jq -r ".topics[0]")
            if [ "$event_sig" != "$event_signature" ]; then
                continue
            fi

            tx_hash=$(echo $event | jq -r '.transactionHash')
            event_block_number=$(echo $event | jq -r '.blockNumber')
            echo "⛓️ Tx Hash: $tx_hash"
            echo "⛓️ Block Number: $((event_block_number))"

            data=$(echo $event | jq -r '.data')
            decoded_event=$(cast decode-event --sig "$event_name" "$data" 2>/dev/null)
            message_id=$(echo "$decoded_event" | sed '1q;d')
            leaf_index=$(echo "$decoded_event" | sed '2q;d' | cut -d ' ' -f 1)

            echo "⛓️ Leaf Index: $leaf_index"
            echo "⛓️ Message ID: $message_id"

            validator_checkpoint=$(fetch_validator_checkpoint "$leaf_index")
            # echo $validator_checkpoint
            validator_message_id=$(extract_checkpoint_message_id "$validator_checkpoint")
            echo "🛡️ Validator Message ID: $validator_message_id"

            # Compare the message IDs
            if [ "$message_id" != "$validator_message_id" ]; then
                echo -e "\n⚠️ MISMATCH FOUND at index $leaf_index:"
                echo "⛓️   Onchain:    $message_id"
                echo "📬 Validator:    $validator_message_id"
                mismatch_found=true
                mismatch_index="$leaf_index"
            else
                echo "  ✅ Match"
                echo "==============================================="
            fi

        done
    done

    if [ "$mismatch_found" = true ]; then
        echo -e "\n✅ Comparison complete. First mismatch found at index $mismatch_index."
    else
        echo -e "\n✅ Comparison complete. No mismatches found in scanned range."
    fi

}

while [ "$#" -gt 0 ]; do
    case "$1" in
        "-h")
            ;&
        "--help")
            echo "$HELP_MESSAGE" >&2
            exit 0
            ;;
        "--rpc-url")
            shift
            rpc_url="$1"
            ;;
        "--merkle-hook-address")
            shift
            address="$1"
            ;;
        "--chain-name")
            shift
            chain="$1"
            ;;
        "--start-block")
            shift
            block_start="$1"
            ;;
        *)
            echo "Unknown argument $1" >&2
            exit 1
            ;;
    esac
    shift
done

if [ -z "$rpc_url" ]; then
    echo "$0: Error: RPC URL not provided. Run -h for usage" >&2
    exit 1
fi
if [ -z "$address" ]; then
    echo "$0: Error: Merkle hook address not provided. Run -h for usage" >&2
    exit 1
fi
if [ -z "$chain" ]; then
    echo "$0: Error: Chain name not provided. Run -h for usage" >&2
    exit 1
fi
if [ -z "$block_start" ]; then
    echo "$0: Error: Block start not provided. Run -h for usage" >&2
    exit 1
fi

main "$rpc_url" "$address" "$chain" "$block_start"

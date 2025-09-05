#!/bin/bash

# Function to extract message_id from merkle insertions response
extract_merkle_message_id() {
    echo "$1" | grep -o '"message_id":"[^"]*' | head -1 | cut -d'"' -f4
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

    curl -s "$rpc_url" \
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

fetch_relayer_checkpoint() {
    domain_id=$1
    current_index=$2
    merkle_url="http://0.0.0.0:9090/merkle_tree_insertions?domain_id=${domain_id}&leaf_index_start=${current_index}&leaf_index_end=$((current_index + 1))"
    curl -s "$merkle_url"
}


# Check if start_index argument is provided
if [ $# -lt 4 ]; then
    echo "Script that goes backwards and compares on-chain merkle tree data with relayer local db" >&2
    echo "Usage: $0 <rpc_url> <merkle_hook_address> <domain_id> <block_start>" >&2
    exit 1
fi

rpc_url=$1
address=$2
domain_id=$3
block_start=$4
mismatch_found=false

batch_size=800
to_block=$block_start
from_block=$to_block

event_name='InsertedIntoTree(bytes32,uint32)'
event_signature='0x253a3a04cab70d47c1504809242d9350cd81627b4f1d50753e159cf8cd76ed33'

echo "Starting comparison from block $block_start..."
echo "==============================================="

while [ "$mismatch_found" = false ]; do
    [ "$to_block" -le 0 ] && break
    to_block=$from_block
    from_block=$(( $to_block - $batch_size ))

    echo "Fetching logs $from_block .. $to_block"
    events=$(fetch_merkle_tree_events $rpc_url $address $from_block $to_block | jq .result)

    # echo "$events"
    event_count=$(echo $events | jq -r length)
    if [ $event_count -eq 0 ]; then
        continue
    fi

    for i in $(seq 0 $event_count); do
        event=$(echo $events | jq -r ".[$i]")
        [ "$event" = "null" ] && continue
        event_sig=$(echo $event | jq -r ".topics[0]")
        if [ $event_sig != $event_signature ]; then
            continue
        fi

        tx_hash=$(echo $event | jq -r '.transactionHash')
        event_block_number=$(echo $event | jq -r '.blockNumber')
        echo "⛓️ Tx Hash: $tx_hash"
        echo "⛓️ Block Number: $event_block_number"

        data=$(echo $event | jq -r '.data')
        decoded_event=$(cast decode-event --sig "$event_name" "$data" 2>/dev/null)
        message_id=$(echo "$decoded_event" | awk '{print $1}')
        leaf_index=$(echo "$decoded_event" | awk '{print $2}' | cut -d ' ' -f 1)

        echo "⛓️ Leaf Index: $leaf_index"
        echo "⛓️ Message ID: $message_id"

        relayer_checkpoint=$(fetch_relayer_checkpoint $domain_id $leaf_index)
        relayer_message_id=$(extract_merkle_message_id "$relayer_checkpoint")
        echo "📬 Relayer Message ID: $relayer_message_id"

        # Compare the message IDs
        if [ "$message_id" != "$relayer_message_id" ]; then
            echo -e "\n⚠️ MISMATCH FOUND at index $leaf_index:"
            echo "⛓️ Onchain:    $message_id"
            echo "📬 Relayer:    $relayer_message_id"
            mismatch_found=true
            mismatch_index="$leaf_index"
        else
            echo "  ✓ Match"
            echo "==============================================="
        fi

    done
done

if [ "$mismatch_found" = true ]; then
    echo -e "\n✅ Comparison complete. First mismatch found at index $mismatch_index."
else
    echo -e "\n✅ Comparison complete. No mismatches found in scanned range."
fi


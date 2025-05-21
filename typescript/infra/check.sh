#!/bin/bash

# Function to extract message_id from checkpoint response
extract_checkpoint_message_id() {
    echo "$1" | jq -r '.value.message_id' 2>/dev/null || echo "$1" | grep -o '"value":{[^}]*"message_id":"[^"]*"' | grep -o '"message_id":"[^"]*"' | cut -d'"' -f4
}

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

# Check if start_index argument is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <start_index>"
    exit 1
fi

start_index=$1
current_index=$start_index
mismatch_found=false

echo "Starting comparison from index $start_index..."
echo "==============================================="

while [ "$mismatch_found" = false ]; do
    echo "Checking index $current_index..."
    
    # Fetch from checkpoint endpoint
    checkpoint_url="https://hyperlane-validator-signatures-hyperevm.s3.ap-northeast-2.amazonaws.com/checkpoint_${current_index}_with_id.json"
    echo -e "\n🌐 API Call: GET $checkpoint_url"
    checkpoint_response=$(curl -s "$checkpoint_url")
    echo "📥 Response size: $(echo "$checkpoint_response" | wc -c) bytes"
    
    # Check if checkpoint request was successful
    if [[ "$checkpoint_response" == *"message_id"* ]]; then
        # Debug: Print the relevant part of the response
        echo "🔍 Debugging checkpoint response:"
        echo "$checkpoint_response"
        
        checkpoint_message_id=$(extract_checkpoint_message_id "$checkpoint_response")
        echo "📋 Extracted checkpoint message_id: $checkpoint_message_id"
        
        # Fetch from merkle insertions endpoint
        merkle_url="http://0.0.0.0:9090/merkle_tree_insertions?leaf_index_start=${current_index}&leaf_index_end=$((current_index + 1))"
        echo -e "\n🌐 API Call: GET $merkle_url"
        merkle_response=$(curl -s "$merkle_url")
        echo "📥 Response size: $(echo "$merkle_response" | wc -c) bytes"
        
        # Debug: Print the relevant part of the response
        echo "🔍 Debugging merkle response:"
        echo "$merkle_response" | grep -A 1 "message_id"
        
        # Check if merkle request was successful
        if [[ "$merkle_response" == *"message_id"* ]]; then
            merkle_message_id=$(extract_merkle_message_id "$merkle_response")
            echo "📋 Extracted merkle message_id: $merkle_message_id"
            
            echo -e "\n📊 Comparison for index $current_index:"
            echo "  Checkpoint message_id: $checkpoint_message_id"
            echo "  Merkle message_id:     $merkle_message_id"
            
            # Compare the message IDs
            if [ "$checkpoint_message_id" != "$merkle_message_id" ]; then
                echo -e "\n⚠️ MISMATCH FOUND at index $current_index:"
                echo "  Checkpoint: $checkpoint_message_id"
                echo "  Merkle:     $merkle_message_id"
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

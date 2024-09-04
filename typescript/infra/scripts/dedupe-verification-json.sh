#!/bin/bash

# Ensure jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: jq is not installed. Please install jq to run this script."
    exit 1
fi

# Get the directory of the script
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Set the path to the config directory
config_dir="$script_dir/../config"

# Find all verification.json files
verification_files=$(find "$config_dir" -name "verification.json")

# Iterate over each verification.json file
for input_file in $verification_files; do
    echo "Processing file: $input_file"

    # Get the list of chains
    chains=$(jq -r 'keys[]' "$input_file")

    # Iterate through each chain and deduplicate its array in-place
    for chain in $chains; do
        echo "Deduplicating array for chain: $chain"
        jq ".$chain |= (reduce .[] as \$item ([]; if any(.[]; .address == \$item.address) then . else . + [\$item] end))" "$input_file" > temp.json && mv temp.json "$input_file"
    done

    echo "File has been deduplicated in-place: $input_file"
    echo
done

echo "All verification.json files have been processed."

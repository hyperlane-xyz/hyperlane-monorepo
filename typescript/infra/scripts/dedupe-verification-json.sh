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

    # Check if the file contains valid JSON
    if ! jq empty "$input_file" &>/dev/null; then
        echo "Error: $input_file contains invalid JSON. Skipping file."
        continue
    fi

    # Get the list of chains
    chains=$(jq -r 'keys[]' "$input_file")

    # Iterate through each chain and deduplicate its array
    for chain in $chains; do
        echo "Deduplicating array for chain: $chain"

        # Deduplicate in memory and only write back if changes are made
        updated_json=$(jq ".$chain |= unique_by(.address)" "$input_file")

        # Only overwrite if there are changes
        if [ "$updated_json" != "$(cat "$input_file")" ]; then
            echo "$updated_json" > "$input_file"
            echo "File has been updated and deduplicated in-place: $input_file"
        else
            echo "No changes needed for $input_file"
        fi
    done

    echo
done

echo "All verification.json files have been processed."


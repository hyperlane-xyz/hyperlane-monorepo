#!/bin/bash

# Usage:
#   ./interface.sh [output-path]           - Generate interface files
#   ./interface.sh test-interface <base> <head>  - Compare interfaces and fail on removals

OUTPUT_PATH=${1:-interface}

# If called with "test-interface", run comparison mode
if [ "$1" = "test-interface" ]; then
    BASE_DIR=$2
    HEAD_DIR=$3

    if [ -z "$BASE_DIR" ] || [ -z "$HEAD_DIR" ]; then
        echo "Usage: ./interface.sh test-interface <base-dir> <head-dir>"
        exit 1
    fi

    REMOVED_FUNCTIONS=""
    ADDED_FUNCTIONS=""
    HAS_REMOVALS=false

    # Check each contract in base for removed functions
    for base_file in "$BASE_DIR"/*.json; do
        [ -f "$base_file" ] || continue
        contract_name=$(basename "$base_file" -abi.json)
        head_file="$HEAD_DIR/$contract_name-abi.json"

        if [ ! -f "$head_file" ]; then
            echo "WARNING: Contract $contract_name was removed entirely"
            HAS_REMOVALS=true
            REMOVED_FUNCTIONS="$REMOVED_FUNCTIONS\n  Contract removed: $contract_name"
            continue
        fi

        # Extract function signatures from base and head
        # Format: functionName(input1,input2,...)->(output1,output2,...)
        base_funcs=$(jq -r '.[] | select(.type == "function") | .name + "(" + ([.inputs[].type] | join(",")) + ")->(" + ([.outputs[].type] | join(",")) + ")"' "$base_file" 2>/dev/null | sort)
        head_funcs=$(jq -r '.[] | select(.type == "function") | .name + "(" + ([.inputs[].type] | join(",")) + ")->(" + ([.outputs[].type] | join(",")) + ")"' "$head_file" 2>/dev/null | sort)

        # Find functions in base that are not in head (removals)
        while IFS= read -r func; do
            [ -z "$func" ] && continue
            if ! echo "$head_funcs" | grep -qxF "$func"; then
                HAS_REMOVALS=true
                REMOVED_FUNCTIONS="$REMOVED_FUNCTIONS\n  $contract_name: $func"
            fi
        done <<< "$base_funcs"

        # Find functions in head that are not in base (additions) - just for info
        while IFS= read -r func; do
            [ -z "$func" ] && continue
            if ! echo "$base_funcs" | grep -qxF "$func"; then
                ADDED_FUNCTIONS="$ADDED_FUNCTIONS\n  $contract_name: $func"
            fi
        done <<< "$head_funcs"
    done

    # Check for new contracts (additions)
    for head_file in "$HEAD_DIR"/*.json; do
        [ -f "$head_file" ] || continue
        contract_name=$(basename "$head_file" -abi.json)
        base_file="$BASE_DIR/$contract_name-abi.json"

        if [ ! -f "$base_file" ]; then
            echo "INFO: New contract added: $contract_name"
        fi
    done

    # Report results
    if [ -n "$ADDED_FUNCTIONS" ]; then
        echo ""
        echo "Functions added (non-breaking):"
        echo -e "$ADDED_FUNCTIONS"
    fi

    if [ "$HAS_REMOVALS" = true ]; then
        echo ""
        echo "ERROR: Functions removed (breaking change):"
        echo -e "$REMOVED_FUNCTIONS"
        echo ""
        echo "This PR removes functions from contract interfaces, which is a breaking change."
        echo "If this is intentional, please review carefully."
        exit 1
    fi

    echo ""
    echo "No breaking interface changes detected (no function removals)."
    exit 0
fi

# Generation mode
EXCLUDE="test|mock|interfaces|libs|upgrade|dependencies"

IFS=$'\n'
CONTRACT_FILES=($(find ./contracts -type f))
unset IFS

echo "Generating interfaces (ABIs) in $OUTPUT_PATH"
mkdir -p $OUTPUT_PATH

for file in "${CONTRACT_FILES[@]}";
do
    if [[ $file =~ .*($EXCLUDE).* ]]; then
        continue
    fi

    # Skip files that don't end in .sol
    if [[ ! "$file" =~ \.sol$ ]]; then
        continue
    fi

    # Extract all contract names from the file
    contracts=$(grep -o '^contract [A-Za-z0-9_][A-Za-z0-9_]*' "$file" | sed 's/^contract //')

    if [ -z "$contracts" ]; then
        continue
    fi

    # Process each contract found in the file
    for contract in $contracts; do
        echo "Generating interface of $contract"
        forge inspect "$contract" abi --json > "$OUTPUT_PATH/$contract-abi.json"
    done
done

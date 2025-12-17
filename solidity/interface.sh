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

    REMOVED_ITEMS=""
    ADDED_ITEMS=""
    HAS_REMOVALS=false

    # Check each contract in base for removed ABI entries
    for base_file in "$BASE_DIR"/*.json; do
        [ -f "$base_file" ] || continue
        contract_name=$(basename "$base_file" -abi.json)
        head_file="$HEAD_DIR/$contract_name-abi.json"

        if [ ! -f "$head_file" ]; then
            echo "WARNING: Contract $contract_name was removed entirely"
            HAS_REMOVALS=true
            REMOVED_ITEMS="$REMOVED_ITEMS\n  Contract removed: $contract_name"
            continue
        fi

        # Extract function signatures: functionName(inputs)->(outputs)
        base_funcs=$(jq -r '.[] | select(.type == "function") | "function " + .name + "(" + ([.inputs[].type] | join(",")) + ")->(" + ([.outputs[].type] | join(",")) + ")"' "$base_file" 2>/dev/null | sort)
        head_funcs=$(jq -r '.[] | select(.type == "function") | "function " + .name + "(" + ([.inputs[].type] | join(",")) + ")->(" + ([.outputs[].type] | join(",")) + ")"' "$head_file" 2>/dev/null | sort)

        # Extract event signatures: eventName(type1,type2,...)
        base_events=$(jq -r '.[] | select(.type == "event") | "event " + .name + "(" + ([.inputs[].type] | join(",")) + ")"' "$base_file" 2>/dev/null | sort)
        head_events=$(jq -r '.[] | select(.type == "event") | "event " + .name + "(" + ([.inputs[].type] | join(",")) + ")"' "$head_file" 2>/dev/null | sort)

        # Extract error signatures: errorName(type1,type2,...)
        base_errors=$(jq -r '.[] | select(.type == "error") | "error " + .name + "(" + ([.inputs[].type] | join(",")) + ")"' "$base_file" 2>/dev/null | sort)
        head_errors=$(jq -r '.[] | select(.type == "error") | "error " + .name + "(" + ([.inputs[].type] | join(",")) + ")"' "$head_file" 2>/dev/null | sort)

        # Extract constructor signature
        base_constructor=$(jq -r '.[] | select(.type == "constructor") | "constructor(" + ([.inputs[].type] | join(",")) + ")"' "$base_file" 2>/dev/null)
        head_constructor=$(jq -r '.[] | select(.type == "constructor") | "constructor(" + ([.inputs[].type] | join(",")) + ")"' "$head_file" 2>/dev/null)

        # Extract fallback/receive
        base_fallback=$(jq -r '.[] | select(.type == "fallback" or .type == "receive") | .type' "$base_file" 2>/dev/null | sort)
        head_fallback=$(jq -r '.[] | select(.type == "fallback" or .type == "receive") | .type' "$head_file" 2>/dev/null | sort)

        # Check for removed functions
        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$head_funcs" | grep -qxF "$item"; then
                HAS_REMOVALS=true
                REMOVED_ITEMS="$REMOVED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$base_funcs"

        # Check for removed events
        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$head_events" | grep -qxF "$item"; then
                HAS_REMOVALS=true
                REMOVED_ITEMS="$REMOVED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$base_events"

        # Check for removed errors
        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$head_errors" | grep -qxF "$item"; then
                HAS_REMOVALS=true
                REMOVED_ITEMS="$REMOVED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$base_errors"

        # Check for constructor changes
        if [ -n "$base_constructor" ] && [ "$base_constructor" != "$head_constructor" ]; then
            HAS_REMOVALS=true
            REMOVED_ITEMS="$REMOVED_ITEMS\n  $contract_name: $base_constructor -> ${head_constructor:-removed}"
        fi

        # Check for removed fallback/receive
        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$head_fallback" | grep -qxF "$item"; then
                HAS_REMOVALS=true
                REMOVED_ITEMS="$REMOVED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$base_fallback"

        # Track additions (non-breaking, for info)
        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$base_funcs" | grep -qxF "$item"; then
                ADDED_ITEMS="$ADDED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$head_funcs"

        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$base_events" | grep -qxF "$item"; then
                ADDED_ITEMS="$ADDED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$head_events"

        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$base_errors" | grep -qxF "$item"; then
                ADDED_ITEMS="$ADDED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$head_errors"
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
    if [ -n "$ADDED_ITEMS" ]; then
        echo ""
        echo "ABI entries added (non-breaking):"
        echo -e "$ADDED_ITEMS"
    fi

    if [ "$HAS_REMOVALS" = true ]; then
        echo ""
        echo "ERROR: ABI entries removed or changed (breaking change):"
        echo -e "$REMOVED_ITEMS"
        echo ""
        echo "This PR removes or modifies entries in contract ABIs, which is a breaking change."
        echo "If this is intentional, please review carefully."
        exit 1
    fi

    echo ""
    echo "No breaking interface changes detected."
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

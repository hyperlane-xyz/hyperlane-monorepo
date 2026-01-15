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

    # Helper: find items in base that are missing from head
    # Usage: find_removed "$base_items" "$head_items" "$contract_name"
    find_removed() {
        local base_items="$1"
        local head_items="$2"
        local contract_name="$3"
        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$head_items" | grep -qxF "$item"; then
                HAS_REMOVALS=true
                REMOVED_ITEMS="$REMOVED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$base_items"
    }

    # Helper: find items in head that are missing from base (additions)
    # Usage: find_added "$base_items" "$head_items" "$contract_name"
    find_added() {
        local base_items="$1"
        local head_items="$2"
        local contract_name="$3"
        while IFS= read -r item; do
            [ -z "$item" ] && continue
            if ! echo "$base_items" | grep -qxF "$item"; then
                ADDED_ITEMS="$ADDED_ITEMS\n  $contract_name: $item"
            fi
        done <<< "$head_items"
    }

    # Helper: extract ABI signatures from a file
    # Usage: extract_signatures "$file" "$type"
    extract_signatures() {
        local file="$1"
        local type="$2"
        case "$type" in
            function)
                jq -r '.[] | select(.type == "function") | "function " + .name + "(" + ([.inputs[].type] | join(",")) + ")->(" + ([.outputs[].type] | join(",")) + ")"' "$file" 2>/dev/null | sort
                ;;
            event)
                jq -r '.[] | select(.type == "event") | "event " + .name + "(" + ([.inputs[].type] | join(",")) + ")"' "$file" 2>/dev/null | sort
                ;;
            error)
                jq -r '.[] | select(.type == "error") | "error " + .name + "(" + ([.inputs[].type] | join(",")) + ")"' "$file" 2>/dev/null | sort
                ;;
            constructor)
                jq -r '.[] | select(.type == "constructor") | "constructor(" + ([.inputs[].type] | join(",")) + ")"' "$file" 2>/dev/null
                ;;
            fallback)
                jq -r '.[] | select(.type == "fallback" or .type == "receive") | .type' "$file" 2>/dev/null | sort
                ;;
        esac
    }

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

        # Check for removals and additions across all ABI types
        for abi_type in function event error constructor fallback; do
            base_items=$(extract_signatures "$base_file" "$abi_type")
            head_items=$(extract_signatures "$head_file" "$abi_type")
            find_removed "$base_items" "$head_items" "$contract_name"
            find_added "$base_items" "$head_items" "$contract_name"
        done
    done

    # Check for new contracts (additions)
    for head_file in "$HEAD_DIR"/*.json; do
        [ -f "$head_file" ] || continue
        contract_name=$(basename "$head_file" -abi.json)
        base_file="$BASE_DIR/$contract_name-abi.json"

        if [ ! -f "$base_file" ]; then
            ADDED_ITEMS="$ADDED_ITEMS\n  New contract: $contract_name"
        fi
    done

    # Report results
    # Exit codes: 0 = no changes, 1 = removals (breaking), 2 = additions only (non-breaking)
    if [ "$HAS_REMOVALS" = true ]; then
        if [ -n "$ADDED_ITEMS" ]; then
            echo ""
            echo "ABI entries added:"
            echo -e "$ADDED_ITEMS"
        fi
        echo ""
        echo "ERROR: ABI entries removed or changed (breaking change):"
        echo -e "$REMOVED_ITEMS"
        echo ""
        echo "This PR removes or modifies entries in contract ABIs, which is a breaking change."
        exit 1
    fi

    if [ -n "$ADDED_ITEMS" ]; then
        echo ""
        echo "ABI entries added:"
        echo -e "$ADDED_ITEMS"
        echo ""
        echo "Interface additions detected (non-breaking)."
        exit 2
    fi

    echo ""
    echo "No interface changes detected."
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

    # Extract all contract names from the file (including abstract contracts)
    contracts=$(grep -oE '^(abstract )?contract [A-Za-z0-9_]+' "$file" | sed 's/^abstract //' | sed 's/^contract //')

    if [ -z "$contracts" ]; then
        continue
    fi

    # Process each contract found in the file
    for contract in $contracts; do
        echo "Generating interface of $contract"
        forge inspect "$contract" abi --json > "$OUTPUT_PATH/$contract-abi.json"
    done
done

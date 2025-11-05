#!/bin/bash
OUTPUT_PATH=${1:-storage}
EXCLUDE="test|mock|interfaces|libs|upgrade|README|Abstract|Static|LayerZero|PolygonPos|Portal"

IFS=$'\n'
CONTRACT_FILES=($(find ./contracts -type f))
unset IFS

echo "Generating layouts in $OUTPUT_PATH"
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
        echo "Generating storage layout of $contract"
        echo "slot  offset  label" > "$OUTPUT_PATH/$contract-layout.tsv"
        forge inspect "$contract" storage --json | jq -r '.storage .[] | "\(.slot)\t\(.offset)\t\(.label)"' >> "$OUTPUT_PATH/$contract-layout.tsv"
    done
done

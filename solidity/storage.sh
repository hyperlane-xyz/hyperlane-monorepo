#!/bin/bash

IFS=$'\n'
CONTRACT_FILES=($(find ./contracts -type f))
unset IFS

for file in "${CONTRACT_FILES[@]}";
do
    contract=$(basename "$file" .sol)

    if [[ $file =~ .*(test|mock|interfaces|libs|upgrade|README|Abstract|Static).* ]]; then
        continue
    fi

    echo "Generating storage layout of $contract"
    forge inspect "$contract" storage --pretty > "storage/$contract.md"
done

#!/bin/sh

# set script location as working directory
cd "$(dirname "$0")"

# Define the artifacts directory
artifactsDir="./artifacts/build-info"
# Define the output file
outputFile="./buildArtifact.json"

# log that we're in the script
echo 'Finding and processing hardhat build artifact...'

# Find the latest JSON build artifact
jsonFiles=$(find "$artifactsDir" -type f -name "*.json" | sort | tail -n 1)
if [[ ! -f "$jsonFiles" ]]; then
  echo 'Failed to find build artifact'
  exit 1
fi

# Extract required keys and write to outputFile
if jq -c '{input, solcLongVersion}' "$jsonFiles" > "$outputFile"; then
  echo 'Finished processing build artifact.'
else
  echo 'Failed to process build artifact with jq'
  exit 1
fi

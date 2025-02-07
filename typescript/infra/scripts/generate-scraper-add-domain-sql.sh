#!/bin/bash

# Example usage:
# ./generate-scraper-add-domain-sql.sh alfajores ancient8 arbitrum avalanche base blast bob bsc bsctestnet
# This will insert the specified domains into the scraper database.

# Change directory to repo root
cd "$(dirname "$0")/../../../"

# Generate the SQL command for inserting domains into the scraper database
echo "insert into domain (id, time_created, time_updated, name, native_token, chain_id, is_test_net, is_deprecated) values"
for name in "$@"; do
  chain_id=$(yq e ".$name.chainId" ../hyperlane-registry/chains/metadata.yaml)
  domain_id=$(yq e ".$name.domainId" ../hyperlane-registry/chains/metadata.yaml)
  if [ -z "$domain_id" ]; then
    echo "Error: domain_id for $name not found" >&2
    exit 1
  fi
  native_token_symbol=$(yq e ".$name.nativeToken.symbol" ../hyperlane-registry/chains/metadata.yaml)
  if [ -z "$native_token_symbol" ]; then
    echo "Error: nativeToken symbol for $name not found" >&2
    exit 1
  fi
  is_testnet=$(yq e ".$name.isTestnet" ../hyperlane-registry/chains/metadata.yaml)
  if [ "$is_testnet" = "true" ]; then
    echo "($domain_id, current_timestamp, current_timestamp, '$name', '$native_token_symbol', $chain_id, true, false)"
  else
    echo "($domain_id, current_timestamp, current_timestamp, '$name', '$native_token_symbol', $chain_id, false, false)"
  fi
done | paste -sd, -

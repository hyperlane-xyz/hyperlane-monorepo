CHAIN=$1
DELEGATE=$2

set -x

SAFE_URL=`yarn ts-node ./scripts/print-chain-metadatas.ts -e mainnet3 | jq -r ".$CHAIN.gnosisSafeTransactionServiceUrl"`
SAFE_ADDRESS=`yarn ts-node ./scripts/print-safes.ts | jq -r ".$CHAIN"`

TOTP=$(($(date +%s) / 3600))
HASH=$(cast keccak "$DELEGATE$TOTP")

DELEGATOR=$(cast wallet address --ledger)
SIGNATURE=$(cast wallet sign --ledger $HASH)

DATA=$(jq -n \
  --arg safe "$SAFE_ADDRESS" \
  --arg delegate "$DELEGATE" \
  --arg delegator "$DELEGATOR" \
  --arg signature "$SIGNATURE" \
  --arg label "$CHAIN-delegate" \
    '{safe: $safe, delegate: $delegate, delegator: $delegator, signature: $signature, label: $label}')

curl -X 'POST' "$SAFE_URL/api/v1/delegates/" \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'X-CSRFToken: wLrSoz75BRvOlTmYVKKWXYDhY8djEW7JJG9ZFWytmzOEVMqAYLqBgHEM9iF1xVYa' \
  -d "$DATA"

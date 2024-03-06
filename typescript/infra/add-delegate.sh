CHAIN=$1
DELEGATE=$2

if [ -z "$CHAIN" ] || [ -z "$DELEGATE" ]; then
  echo "Usage: $0 <chain> <delegate>"
  exit 1
fi

set -x

SAFE_URL=`yarn ts-node ./scripts/print-chain-metadatas.ts -e mainnet3 | jq -r ".$CHAIN.gnosisSafeTransactionServiceUrl"`
SAFE_ADDRESS=`yarn ts-node ./scripts/print-safes.ts | jq -r ".$CHAIN"`

# see https://safe-transaction-mainnet.safe.global delegates endpoint docs
TOTP=$(($(date +%s) / 3600))

DELEGATOR=$(cast wallet address --ledger)
SIGNATURE=$(cast wallet sign --ledger "$DELEGATE$TOTP")

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

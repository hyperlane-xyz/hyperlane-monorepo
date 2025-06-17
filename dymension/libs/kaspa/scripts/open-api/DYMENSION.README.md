## What?

A generated rust library for 

- https://kas.fyi/
- https://api-tn10.kaspa.org/docs

generates to lib/api

## Commit

Used `Tue 17 Jun 2025 14:31:33 BST` version of https://api.kaspa.org/docs

## Steps


```
brew install openapi-generator

openapi-generator version
# 7.13.0

# the API author has included some non regular tags (learned in discord: https://github.com/supertypo/kaspa-rest-proxy/issues/1)
jq 'walk(if type == "object" and has("strict_query_params") then del(.strict_query_params) else . end)' openapi.json > stripped.json

openapi-generator generate -i stripped.json -g rust -o ../../lib/api

## NOTE: THEN IT IS NECESSARY TO FIX A BUILD ERROR: there is an incorrect path 'models::models::...' it should be just 'models::...'
```
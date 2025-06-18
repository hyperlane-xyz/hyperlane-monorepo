## What?

A generated rust library for

- https://kas.fyi/
- https://api-tn10.kaspa.org/docs

generates to lib/api

## FAQ

1. X doesn't work | Maybe the codegen is wrong or the openapi spec is wrong.

## Commit

Used `Tue 17 Jun 2025 14:31:33 BST` version of https://api.kaspa.org/docs

## Steps

```
brew install openapi-generator

openapi-generator version
# 7.13.0

# the API author has included some non regular tags (learned in discord: https://github.com/supertypo/kaspa-rest-proxy/issues/1)
jq 'walk(if type == "object" and has("strict_query_params") then del(.strict_query_params) else . end)' openapi.json > stripped.json

## (ALSO NEED TO REMOVE LICENSE PART OF JSON)

openapi-generator generate -i stripped.json -g rust -o ../../lib/api --additional-properties=supportMiddleware=true,topLevelApiClient=true,useBonBuilder=true,useSingleRequestParameter=true,supportAsync=true


## NOTE: THEN IT IS NECESSARY TO FIX A BUILD ERROR(S)

1. there is an incorrect path 'models::models::...' it should be just 'models::...' (manual fix)
2. Replace i32 with i64
3. Rename cargo package name and fix the version number


```

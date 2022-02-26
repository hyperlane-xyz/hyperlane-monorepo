# script for auto-formatting supported files
# Run from root (./scripts/format.sh)

set -e

# solidity
npm --prefix ./solidity/abacus-core run prettier
npm --prefix ./solidity/abacus-xapps run prettier

# typescript
npm --prefix ./typescript/contract-metrics run prettier
npm --prefix ./typescript/abacus-deploy run prettier
npm --prefix ./typescript/abacus-sdk run prettier
npm --prefix ./typescript/abacus-tests run prettier

# script for auto-formatting supported files
# Run from root (./scripts/format.sh)

set -e

# solidity
npm --prefix ./solidity/optics-core run prettier
npm --prefix ./solidity/optics-xapps run prettier

# typescript
npm --prefix ./typescript/contract-metrics run prettier
npm --prefix ./typescript/optics-deploy run prettier
npm --prefix ./typescript/optics-provider run prettier
npm --prefix ./typescript/optics-tests run prettier

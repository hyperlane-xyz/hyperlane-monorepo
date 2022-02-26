#!/bin/bash
set -e

cd ./typescript/abacus-deploy
npm run deploy-core
npm run deploy-bridge
cd ../../solidity/optics-core
npm run verify
cd ../optics-xapps
npm run verify
#!/bin/bash
set -exuo pipefail

cd solidity/core
npm publish

cd ../app
npm publish

cd ../apps
npm publish

cd ../../typescript/utils
npm publish

cd ../sdk
npm publish

cd ../deploy
npm publish

cd ../hardhat
npm publish

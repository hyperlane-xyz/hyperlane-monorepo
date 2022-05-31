set -e
set -u
set +x

npm pack @gelatonetwork/core-sdk
npm pack @gelatonetwork/gelato-relay-sdk

gunzip *.tgz

mkdir core-sdk && tar xf gelatonetwork-core-sdk-* -C core-sdk
mkdir relay-sdk && tar xf gelatonetwork-gelato-relay-sdk-* -C relay-sdk

// Default empty artifact array when `yarn build:zk` hasn't been run
// This file will be populated with build artifacts in dist/zksync after running the build:zk command
export const buildArtifact = {
  solcLongVersion: '',
  zk_version: '',
  input: {
    language: 'Solidity',
    sources: {},
    settings: {
      optimizer: {
        enabled: false,
        runs: 200,
      },
      outputSelection: {},
      evmVersion: 'london',
      remappings: [],
    },
  },
};

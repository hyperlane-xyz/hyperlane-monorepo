import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';

module.exports = {
  solidity: {
    version: '0.8.22',
    settings: {
      optimizer: {
        enabled: true,
        runs: 999999,
      },
    },
  },
  mocha: {
    bail: true,
    import: 'tsx',
  },
};

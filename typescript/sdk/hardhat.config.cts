require('@nomiclabs/hardhat-ethers');
require('@nomiclabs/hardhat-waffle');
require('@typechain/hardhat');
require('hardhat-gas-reporter');
require('solidity-coverage');

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: '0.8.19',
    settings: {
      optimizer: {
        enabled: true,
        runs: 999999,
      },
    },
  },
  gasReporter: {
    currency: 'USD',
  },
  mocha: {
    bail: true,
    import: 'tsx',
  },
};

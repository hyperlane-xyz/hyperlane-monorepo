import './lib/index';
import '@nomiclabs/hardhat-waffle';
import "hardhat-gas-reporter";

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: '0.7.6',
  gasReporter: {
    currency: "USD",
  },
};

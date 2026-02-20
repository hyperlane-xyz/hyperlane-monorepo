import '@nomiclabs/hardhat-ethers';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import 'solidity-coverage';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: '0.8.22',
  },
  gasReporter: {
    currency: 'USD',
  },
  typechain: {
    outDir: './src/types',
    target: 'ethers-v6',
    alwaysGenerateOverloads: true,
    node16Modules: true,
    tsNocheck: true,
  },
};

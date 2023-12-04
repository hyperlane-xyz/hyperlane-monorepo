import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    compilers: [
      {
        version: '0.8.19',
      },
    ],
  },
  gasReporter: {
    currency: 'USD',
  },
  typechain: {
    outDir: './src/types',
    target: 'ethers-v5',
    alwaysGenerateOverloads: true,
  },
};

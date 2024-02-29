import '@nomicfoundation/hardhat-verify';
import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import 'solidity-coverage';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: '0.8.19',
    settings: {
      optimizer: {
        enabled: true,
        runs: 999_999,
      },
    },
  },
  gasReporter: {
    currency: 'USD',
  },
  typechain: {
    outDir: './types',
    target: 'ethers-v5',
    alwaysGenerateOverloads: true,
  },
  mocha: {
    bail: true,
  },
  networks: {
    viction: {
      url: 'https://rpc.viction.xyz', // for mainnet
    },
  },
  etherscan: {
    apiKey: {
      viction: 'tomoscan2023',
    },
    customChains: [
      {
        network: 'viction',
        chainId: 88, // for mainnet
        urls: {
          apiURL: 'https://www.vicscan.xyz/api/contract/hardhat/verify', // for mainnet
          browserURL: 'https://vicscan.xyz', // for mainnet
        },
      },
    ],
  },
};

import '@matterlabs/hardhat-zksync-solc';
import '@nomiclabs/hardhat-ethers';
import 'hardhat-ignore-warnings';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  zksolc: {
    version: '1.5.3',
    compilerSource: 'binary',
    enableEraVMExtensions: true,
  },
  defaultNetwork: 'zkSyncNetwork',
  networks: {
    zkSyncNetwork: {
      url: 'http://127.0.0.1:8011',
      ethNetwork: '',
      zksync: true,
    },
  },
  solidity: {
    version: '0.8.19',
    settings: {
      optimizer: {
        enabled: true,
        runs: 999_999,
      },
    },
  },
  mocha: {
    bail: true,
    import: 'tsx',
  },
  warnings: {
    // turn off all warnings for libs:
    'fx-portal/**/*': {
      default: 'off',
    },
  },
  paths: {
    sources: './contracts',
    cache: './cache-zk',
    artifacts: './artifacts-zk',
  },
};

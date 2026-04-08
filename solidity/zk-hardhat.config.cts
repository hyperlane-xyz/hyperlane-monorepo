import '@matterlabs/hardhat-zksync-solc';
import '@nomicfoundation/hardhat-foundry';
import '@nomiclabs/hardhat-ethers';
import 'hardhat-ignore-warnings';

import { rootHardhatConfig } from './rootHardhatConfig.cjs';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  ...rootHardhatConfig,
  // Override solidity version — era-solidity only supports up to 0.8.30
  // https://github.com/matter-labs/era-solidity/releases
  solidity: {
    ...rootHardhatConfig.solidity,
    version: '0.8.30',
  },
  zksolc: {
    version: '1.5.12',
    compilerSource: 'binary',
    enableEraVMExtensions: true,
    settings: {
      libraries: {},
    },
  },
  defaultNetwork: 'ZKsyncInMemoryNode',
  networks: {
    ZKsyncInMemoryNode: {
      url: 'http://127.0.0.1:8011',
      ethNetwork: '',
      zksync: true,
    },
  },
  paths: {
    sources: './contracts',
    cache: './cache-zk',
    artifacts: './artifacts-zk',
  },
};

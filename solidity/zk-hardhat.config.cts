import '@matterlabs/hardhat-zksync-solc';
import '@nomiclabs/hardhat-ethers';
import 'hardhat-ignore-warnings';

import { rootHardhatConfig } from './rootHardhatConfig.cjs';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  ...rootHardhatConfig,
  zksolc: {
    version: '1.5.12',
    compilerSource: 'binary',
    enableEraVMExtensions: true,
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

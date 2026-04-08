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
  // Override solidity version — zkvm-solc 0.8.30 crashes with EPIPE on CI
  // when compiling the full contract set. Pin to 0.8.22 (last known working).
  // https://github.com/matter-labs/era-solidity/releases
  solidity: {
    ...rootHardhatConfig.solidity,
    version: '0.8.22',
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

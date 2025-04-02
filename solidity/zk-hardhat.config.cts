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
    version: '1.5.3',
    compilerSource: 'binary',
    enableEraVMExtensions: true,
  },
  paths: {
    sources: './contracts',
    cache: './cache-zk',
    artifacts: './artifacts-zk',
  },
};

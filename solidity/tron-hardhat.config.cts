import './plugins/hardhat-tron-solc.cjs';
import '@nomicfoundation/hardhat-foundry';
import '@nomiclabs/hardhat-ethers';
import 'hardhat-ignore-warnings';

import { rootHardhatConfig } from './rootHardhatConfig.cjs';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  ...rootHardhatConfig,
  paths: {
    sources: './contracts',
    cache: './cache-tron',
    artifacts: '../typescript/tron-sdk/src/abi',
  },
};

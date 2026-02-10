import 'hardhat-deploy';
import '@layerzerolabs/hardhat-tron';
import '@nomicfoundation/hardhat-foundry';
import '@nomiclabs/hardhat-ethers';
import 'hardhat-ignore-warnings';

import { rootHardhatConfig } from './rootHardhatConfig.cjs';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  ...rootHardhatConfig,
  tronSolc: {
    enable: true,
    filter: [],
    compilers: [{ version: '0.8.22' }],
  },
  networks: {
    tron: {
      url: 'https://api.trongrid.io/jsonrpc',
      tron: true,
    },
  },
  paths: {
    sources: './contracts',
    cache: './cache-tron',
    artifacts: './artifacts-tron',
  },
};

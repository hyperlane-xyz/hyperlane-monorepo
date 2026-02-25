import './plugins/hardhat-tron-solc.cjs';
import '@nomicfoundation/hardhat-ethers';
import '@typechain/hardhat';
import 'hardhat-ignore-warnings';

import { rootHardhatConfig } from './rootHardhatConfig.cjs';

/**
 * Hardhat configuration for compiling Hyperlane contracts for Tron.
 *
 * Uses tron-solc compiler (via hardhat-tron-solc plugin) with
 * @nomicfoundation/hardhat-foundry for remapping support.
 *
 * Produces both (self-contained within solidity package):
 * - Raw ABI artifacts in ./artifacts-tron/ (for AltVM clients)
 * - TypeChain factories in ./artifacts-tron/typechain/ (for ethers deployers)
 */
module.exports = {
  ...rootHardhatConfig,
  paths: {
    sources: './contracts',
    artifacts: '../typescript/tron-sdk/src/abi',
    cache: './cache-tron',
  },
  typechain: {
    outDir: '../typescript/tron-sdk/src/typechain',
    target: 'ethers-v6',
    node16Modules: true,
  },
};

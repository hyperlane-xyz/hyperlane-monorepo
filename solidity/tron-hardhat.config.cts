import '@nomicfoundation/hardhat-foundry';
import '@nomiclabs/hardhat-ethers';
import '@typechain/hardhat';

import { rootHardhatConfig } from './rootHardhatConfig.cjs';

/**
 * Hardhat configuration for compiling Hyperlane contracts for Tron.
 * Inherits from rootHardhatConfig for shared settings.
 *
 * Uses standard solc with @nomicfoundation/hardhat-foundry for remapping support.
 * The FOUNDRY_PROFILE=tron remapping overrides @openzeppelin/contracts/utils/Create2.sol
 * with our patched version that uses 0x41 prefix for TVM CREATE2 compatibility.
 */
module.exports = {
  ...rootHardhatConfig,
  typechain: {
    outDir: '../typescript/tron-sdk/src/typechain',
    target: 'ethers-v5',
    alwaysGenerateOverloads: true,
    node16Modules: true,
  },
  paths: {
    sources: './contracts',
    artifacts: './artifacts-tron',
    cache: './cache-tron',
  },
};

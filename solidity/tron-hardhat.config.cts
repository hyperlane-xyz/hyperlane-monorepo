import './plugins/hardhat-tron-solc.cjs';
import '@nomicfoundation/hardhat-foundry';
import '@nomicfoundation/hardhat-viem';
import 'hardhat-ignore-warnings';

import {rootHardhatConfig} from "./rootHardhatConfig.cjs";

/**
 * Hardhat configuration for compiling Hyperlane contracts for Tron.
 *
 * Uses tron-solc compiler (via hardhat-tron-solc plugin) with
 * @nomicfoundation/hardhat-foundry for remapping support.
 *
 * Produces raw ABI artifacts in ./artifacts-tron/ for downstream Tron clients.
 */
module.exports = {
  ...rootHardhatConfig,
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts-tron",
    cache: "./cache-tron",
  },
};

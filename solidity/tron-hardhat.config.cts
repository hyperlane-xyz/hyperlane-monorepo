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
 * TypeChain output is configured for compatibility and may be absent in viem flows.
 */
module.exports = {
  ...rootHardhatConfig,
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts-tron",
    cache: "./cache-tron",
  },
  typechain: {
    outDir: "./artifacts-tron/typechain",
    target: "ethers-v5",
    alwaysGenerateOverloads: true,
    node16Modules: true,
  },
};

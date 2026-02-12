import "./plugins/hardhat-tron-solc.cjs";
import "@nomicfoundation/hardhat-foundry";
import "@nomiclabs/hardhat-ethers";
import "@typechain/hardhat";
import "hardhat-ignore-warnings";

import {rootHardhatConfig} from "./rootHardhatConfig.cjs";

/**
 * Hardhat configuration for compiling Hyperlane contracts for Tron.
 *
 * Uses tron-solc compiler (via hardhat-tron-solc plugin) with
 * @nomicfoundation/hardhat-foundry for remapping support.
 *
 * Produces both:
 * - Raw ABI artifacts in ../typescript/tron-sdk/src/abi/ (for AltVM clients)
 * - TypeChain factories in ../typescript/tron-sdk/src/typechain/ (for ethers deployers)
 */
module.exports = {
  ...rootHardhatConfig,
  paths: {
    sources: "./contracts",
    artifacts: "../typescript/tron-sdk/src/abi",
    cache: "./cache-tron",
  },
  typechain: {
    outDir: "../typescript/tron-sdk/src/typechain",
    target: "ethers-v5",
    alwaysGenerateOverloads: true,
    node16Modules: true,
  },
};

import "./plugins/hardhat-tron-solc.cjs";
import "@nomicfoundation/hardhat-foundry";
import "@nomiclabs/hardhat-ethers";
import "@typechain/hardhat";
import "hardhat-ignore-warnings";

import { subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";

import {rootHardhatConfig} from "./rootHardhatConfig.cjs";

const TRON_UNSUPPORTED_SOURCE_SUFFIXES = [
  "/contracts/token/CrossCollateralRouter.sol",
  "/contracts/token/CrossCollateralRoutingFee.sol",
];

// tron-solc currently crashes compiling CrossCollateral contracts. Exclude only
// those sources from the Tron artifact build until tron-solc is fixed.
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, __, runSuper) => {
  const sourcePaths = await runSuper();
  return sourcePaths.filter(
    (sourcePath: string) =>
      !TRON_UNSUPPORTED_SOURCE_SUFFIXES.some((suffix) =>
        sourcePath.endsWith(suffix),
      ),
  );
});

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

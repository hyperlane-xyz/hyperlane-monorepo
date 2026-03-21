import "./plugins/hardhat-tron-solc.cjs";
import "@nomicfoundation/hardhat-foundry";
import "@nomiclabs/hardhat-ethers";
import "@typechain/hardhat";
import "hardhat-ignore-warnings";

import { subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";

import {rootHardhatConfig} from "./rootHardhatConfig.cjs";

// tron-solc WASM aborts when the total compilation input is too large.
// Exclude contracts not needed for tron deployments to stay under the limit.
const TRON_EXCLUDED_PATTERNS = [
  "/contracts/mock/",
  "/contracts/isms/hook/",
  "/contracts/hooks/OPStackHook.sol",
  "/contracts/hooks/aggregation/ERC5164Hook.sol",
  "/contracts/token/extensions/OPL2ToL1TokenBridgeNative.sol",
  "/contracts/token/CCTP",
  "/contracts/libs/CctpMessageV1.sol",
  "/contracts/AttributeCheckpointFraud.sol",
  "/contracts/CheckpointFraudProofs.sol",
];

// Test contracts kept for tron-sdk (TestStorage, ERC20Test)
const TRON_TEST_ALLOWLIST = [
  "TestStorage.sol",
  "ERC20Test.sol",
];

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, __, runSuper) => {
  const sourcePaths = await runSuper();
  return sourcePaths.filter((sourcePath: string) => {
    if (TRON_EXCLUDED_PATTERNS.some((p) => sourcePath.includes(p))) return false;
    if (sourcePath.includes("/contracts/test/")) {
      return TRON_TEST_ALLOWLIST.some((f) => sourcePath.endsWith(f));
    }
    return true;
  });
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
  solidity: {
    ...rootHardhatConfig.solidity,
    // tron-solc latest is 0.8.24
    version: '0.8.24',
  },
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

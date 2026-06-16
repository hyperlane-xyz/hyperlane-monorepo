import "@nomicfoundation/hardhat-foundry";
import "@nomiclabs/hardhat-ethers";
import "@typechain/hardhat";
import "hardhat-ignore-warnings";

import { subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";

import {rootHardhatConfig} from "./rootHardhatConfig.cjs";

// Contracts requiring cancun (transient storage / push0). Excluded from the
// paris build; the slim base InterchainGasPaymaster compiles cleanly without them.
const PARIS_EXCLUDED_PATTERNS = [
  "/contracts/libs/TransientStorage.sol",
  "/contracts/libs/ReentrancyGuardTransient.sol",
  "/contracts/libs/AbstractOffchainQuoter.sol",
  "/contracts/hooks/igp/OffchainQuotedIGP.sol",
  "/contracts/hooks/igp/InterchainGasPaymaster.sol",
  "/contracts/token/QuotedCalls.sol",
  "/contracts/token/fees/OffchainQuotedLinearFee.sol",
  "/contracts/token/libs/AbstractPredicateWrapper.sol",
  "/contracts/token/extensions/PredicateCrossCollateralRouterWrapper.sol",
  "/contracts/token/extensions/PredicateRouterWrapper.sol",
  "/contracts/test/",
  "/contracts/mock/",
];

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, __, runSuper) => {
  const sourcePaths = await runSuper();
  return sourcePaths.filter(
    (sourcePath: string) =>
      !PARIS_EXCLUDED_PATTERNS.some((p) => sourcePath.includes(p)),
  );
});

/**
 * Hardhat configuration for compiling Hyperlane contracts targeting paris.
 * Used for chains whose EVM lacks PUSH0 (Shanghai+) or MCOPY/transient storage
 * (Cancun+). Affected chains include coti, electroneum, viction (no PUSH0)
 * and chiliz, incentiv, metis, prom, pulsechain, taiko, torus (no MCOPY).
 *
 * Produces (self-contained within solidity package):
 * - Raw artifacts in ./artifacts-paris/
 * - TypeChain factories in ./artifacts-paris/typechain/
 *
 * MinimalInterchainGasPaymaster (slim base, no offchain quoting) is included;
 * the cancun-deployed InterchainGasPaymaster and the offchain-quoting tree
 * are excluded (require cancun for transient storage opcodes).
 */
module.exports = {
  ...rootHardhatConfig,
  solidity: {
    ...rootHardhatConfig.solidity,
    settings: {
      ...rootHardhatConfig.solidity.settings,
      evmVersion: "paris",
    },
  },
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts-paris",
    cache: "./cache-paris",
  },
  typechain: {
    outDir: "./artifacts-paris/typechain",
    target: "ethers-v5",
    alwaysGenerateOverloads: true,
    node16Modules: true,
  },
};

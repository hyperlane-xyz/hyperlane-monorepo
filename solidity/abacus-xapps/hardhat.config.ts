import "solidity-coverage";
import "@typechain/hardhat";
import "@nomiclabs/hardhat-waffle";
import "hardhat-gas-reporter";
import "@abacus-network/hardhat";

import { task } from "hardhat/config";

import * as dotenv from "dotenv";
dotenv.config();

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.7.6",
    settings: {
      optimizer: {
        enabled: true,
        runs: 999999,
      },
    },
  },
  gasReporter: {
    currency: "USD",
  },
  typechain: {
    outDir: "./typechain",
    target: "ethers-v5",
    alwaysGenerateOverloads: false, // should overloads with full signatures like deposit(uint256) be generated always, even if there are no overloads?
  },
};

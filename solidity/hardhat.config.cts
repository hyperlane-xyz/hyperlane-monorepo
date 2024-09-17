import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import 'hardhat-ignore-warnings';
import 'solidity-coverage';

import { internalTask } from "hardhat/config";
import { TASK_COMPILE_GET_REMAPPINGS } from "hardhat/builtin-tasks/task-names";

internalTask(TASK_COMPILE_GET_REMAPPINGS).setAction(
  async (): Promise<Record<string, string>> => {
    return {"forge-std": "forge-std/src"};
  }
);

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: '0.8.19',
    settings: {
      optimizer: {
        enabled: true,
        runs: 999_999,
      },
    },
  },
  gasReporter: {
    currency: 'USD',
  },
  typechain: {
    outDir: './types',
    target: 'ethers-v5',
    alwaysGenerateOverloads: true,
    node16Modules: true,
  },
  mocha: {
    bail: true,
    import: 'tsx',
  },
  warnings: {
    // turn off all warnings for libs:
    'fx-portal/**/*': {
      default: 'off',
    },
  },
};

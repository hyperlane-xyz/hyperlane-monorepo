import '@nomicfoundation/hardhat-foundry';
import '@nomiclabs/hardhat-ethers';
import { subtask } from 'hardhat/config';
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from 'hardhat/builtin-tasks/task-names';

import { rootHardhatConfig } from './rootHardhatConfig.cjs';

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async () => [
  `${__dirname}/contracts/middleware/InterchainAccountRouter.sol`,
]);

// Tempo charges 1,000 gas per deployed byte and caps transactions at 30M gas.
// Compile the full V3 router separately; its constructor also deploys the ICA
// implementation and CommitmentReadIsm. Keep the regular build unchanged.
module.exports = {
  ...rootHardhatConfig,
  solidity: {
    ...rootHardhatConfig.solidity,
    settings: {
      ...rootHardhatConfig.solidity.settings,
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    artifacts: './artifacts-tempo',
    cache: './cache-tempo',
  },
};

import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from 'hardhat/builtin-tasks/task-names';
import { subtask } from 'hardhat/config';
import path from 'path';
import 'solidity-coverage';

async function configureHardhat() {
  await subtask(
    TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS,
    async (_, { config }, runSuper) => {
      const paths = await runSuper();

      const morePaths = paths.filter((solidityFilePath) => {
        const relativePath = path.relative(
          config.paths.sources,
          solidityFilePath,
        );
        console.log('relativePath', relativePath);
        return !relativePath.includes('avs/');
      });
      console.log('morePaths', morePaths);
      return morePaths;
    },
  );
}

configureHardhat();

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: '0.8.9',
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
};

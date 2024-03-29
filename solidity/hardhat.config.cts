require('@nomiclabs/hardhat-ethers');
require('@nomiclabs/hardhat-waffle');
require('@typechain/hardhat');
require('hardhat-gas-reporter');
require('solidity-coverage');
const taskNames = require('hardhat/builtin-tasks/task-names');
const hardhatConfig = require('hardhat/config');
const path = require('path');
const fs = require('fs');

// Required to compensate for Hardhat's lack of internal support for ESM
// Copied from https://github.com/NomicFoundation/hardhat/issues/3385#issuecomment-1841380253
hardhatConfig
  .subtask(taskNames.TASK_COMPILE_SOLIDITY)
  .setAction(async (_, { config }, runSuper) => {
    const superRes = await runSuper();

    try {
      fs.writeFileSync(
        path.join(config.paths.root, 'types', 'package.json'),
        '{ "type": "commonjs" }',
      );
    } catch (error) {
      console.error('Error writing package.json: ', error);
    }

    return superRes;
  });

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
  },
  mocha: {
    bail: true,
  },
};

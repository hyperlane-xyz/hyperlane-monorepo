import '@nomicfoundation/hardhat-foundry';
import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import 'hardhat-ignore-warnings';
import 'solidity-coverage';

import { rootHardhatConfig } from './rootHardhatConfig.cjs';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  ...rootHardhatConfig,
  solidity: {
    compilers: [rootHardhatConfig.solidity],
    overrides: {
      // Pinned below the suite-wide runs to keep the runtime bytecode under the
      // EIP-170 24576-byte limit. Mirrors the Foundry compilation_restrictions
      // entry in foundry.toml; keep the two in sync.
      'contracts/token/CrossCollateralRouter.sol': {
        ...rootHardhatConfig.solidity,
        settings: {
          ...rootHardhatConfig.solidity.settings,
          optimizer: {
            ...rootHardhatConfig.solidity.settings.optimizer,
            runs: 5_800,
          },
        },
      },
    },
  },
  gasReporter: {
    currency: 'USD',
  },
  typechain: {
    outDir: './core-utils/typechain',
    target: 'ethers-v5',
    alwaysGenerateOverloads: true,
    node16Modules: true,
  },
};

/**
 * Shared configuration for hardhat projects
 * @type import('hardhat/config').HardhatUserConfig
 */
export const rootHardhatConfig = {
  solidity: {
    version: '0.8.22',
    settings: {
      optimizer: {
        enabled: true,
        runs: 999_999,
      },
    },
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

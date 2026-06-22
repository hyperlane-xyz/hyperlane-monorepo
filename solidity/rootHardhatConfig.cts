/**
 * Shared configuration for hardhat projects
 * @type import('hardhat/config').HardhatUserConfig
 */
export const rootHardhatConfig = {
  solidity: {
    version: '0.8.33',
    settings: {
      evmVersion: 'cancun',
      optimizer: {
        enabled: true,
        runs: 9_990,
      },
    },
  },
  mocha: {
    bail: true,
    import: 'tsx',
  },
};

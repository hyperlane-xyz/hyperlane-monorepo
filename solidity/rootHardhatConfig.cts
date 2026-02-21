/**
 * Shared configuration for hardhat projects
 * @type import('hardhat/config').HardhatUserConfig
 */
export const rootHardhatConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.22',
        settings: {
          optimizer: {
            enabled: true,
            runs: 999_999,
          },
        },
      },
    ],
    overrides: {
      'contracts/token/extensions/MultiCollateral.sol': {
        version: '0.8.22',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  mocha: {
    bail: true,
    import: 'tsx',
  },
};

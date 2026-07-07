/**
 * Shared configuration for hardhat projects
 * @type import('hardhat/config').HardhatUserConfig
 */
export const rootHardhatConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.33',
        settings: {
          evmVersion: 'cancun',
          optimizer: {
            enabled: true,
            runs: 10_000,
          },
        },
      },
    ],
    overrides: {
      // Pinned below the suite-wide runs to keep the runtime bytecode under the
      // EIP-170 24576-byte limit. Mirrors the Foundry compilation_restrictions
      // entry in foundry.toml; keep the two in sync.
      'contracts/token/CrossCollateralRouter.sol': {
        version: '0.8.33',
        settings: {
          evmVersion: 'cancun',
          optimizer: {
            enabled: true,
            runs: 5_800,
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

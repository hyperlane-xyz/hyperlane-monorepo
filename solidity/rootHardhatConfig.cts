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
        // Stopgap: lowered from 9_990 to keep CrossCollateralRouter under the
        // EIP-170 24576-byte limit. Kept in sync with foundry.toml. Restore
        // once its bytecode is trimmed (e.g. rebalance-target logic moved to a
        // linked library).
        runs: 5_800,
      },
    },
  },
  mocha: {
    bail: true,
    import: 'tsx',
  },
};

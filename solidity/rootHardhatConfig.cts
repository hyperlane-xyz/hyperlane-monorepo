/**
 * Shared configuration for hardhat projects
 * @type import('hardhat/config').HardhatUserConfig
 */
export const rootHardhatConfig = {
  // Single-compiler shape: the Tron and zksync configs spread
  // `solidity` and override only `version`, which relies on `settings`
  // (notably `evmVersion`) living at this top level. The EIP-170 size pin for
  // CrossCollateralRouter is an EVM-only concern and lives in the EVM
  // `hardhat.config.cts` / `foundry.toml` instead.
  solidity: {
    version: '0.8.33',
    settings: {
      evmVersion: 'cancun',
      optimizer: {
        enabled: true,
        runs: 10_000,
      },
    },
  },
  mocha: {
    bail: true,
    import: 'tsx',
  },
};

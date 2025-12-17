// Default empty artifact array when `pnpm generate-artifacts` hasn't been run
// This file will be populated with contract artifacts in `dist/artifacts` directory after running the `generate-artifacts` command
export const starknetContracts = {
  contracts: {},
  token: {},
  mocks: {},
} as const;

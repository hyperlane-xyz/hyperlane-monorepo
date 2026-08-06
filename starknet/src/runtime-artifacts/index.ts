import type { StarknetRuntimeContracts } from '../types.js';

// Default empty artifacts when `pnpm generate-artifacts` has not run.
// The generator replaces the emitted dist file with the published runtime data.
export const starknetRuntimeContracts: StarknetRuntimeContracts = {
  contracts: {},
  token: {},
  mocks: {},
};

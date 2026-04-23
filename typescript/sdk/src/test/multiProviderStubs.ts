import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { vi } from 'vitest';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

/**
 * Takes a MultiProtocolProvider instance and stubs its get*Provider methods to
 * return mock providers. More provider methods can be added here as needed.
 * Note: callers should call `vi.restoreAllMocks()` after tests complete.
 */
export function stubMultiProtocolProvider(
  multiProvider: MultiProtocolProvider,
): void {
  vi.spyOn(multiProvider, 'getEthersV5Provider').mockReturnValue({
    getBalance: async () => '100',
  } as any);
  vi.spyOn(multiProvider, 'getCosmJsProvider').mockReturnValue({
    getBalance: async () => ({ amount: '100' }),
  } as any);
  vi.spyOn(multiProvider, 'getCosmJsWasmProvider').mockReturnValue({
    getBalance: async () => ({ amount: '100' }),
    queryContractSmart: async () => ({
      type: { native: { fungible: { denom: 'denom' } } },
    }),
  } as any);
  vi.spyOn(multiProvider, 'getSolanaWeb3Provider').mockReturnValue({
    getBalance: async () => '100',
    getTokenAccountBalance: async () => ({ value: { amount: '100' } }),
    getAccountInfo: async () => ({
      owner: TOKEN_2022_PROGRAM_ID,
    }),
  } as any);
}

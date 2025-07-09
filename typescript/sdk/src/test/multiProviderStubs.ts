import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import sinon from 'sinon';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

/**
 * Takes a MultiProtocolProvider instance and stubs it's get*Provider methods to
 * return mock providers. More provider methods can be added her as needed.
 * Note: callers should call `sandbox.restore()` after tests complete.
 */
export function stubMultiProtocolProvider(
  multiProvider: MultiProtocolProvider,
): sinon.SinonSandbox {
  const sandbox = sinon.createSandbox();
  sandbox.stub(multiProvider, 'getEthersV5Provider').returns({
    getBalance: async () => '100',
  } as any);
  sandbox.stub(multiProvider, 'getCosmJsProvider').returns({
    getBalance: async () => ({ amount: '100' }),
  } as any);
  sandbox.stub(multiProvider, 'getCosmJsWasmProvider').returns({
    getBalance: async () => ({ amount: '100' }),
    queryContractSmart: async () => ({
      type: { native: { fungible: { denom: 'denom' } } },
    }),
  } as any);
  sandbox.stub(multiProvider, 'getSolanaWeb3Provider').returns({
    getBalance: async () => '100',
    getTokenAccountBalance: async () => ({ value: { amount: '100' } }),
    getAccountInfo: async () => ({
      owner: TOKEN_2022_PROGRAM_ID,
    }),
  } as any);
  return sandbox;
}

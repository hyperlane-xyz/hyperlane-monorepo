import { expect } from 'chai';
import { Connection } from '@solana/web3.js';

import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { toSquadsProvider } from './provider.js';

type SolanaProvider = ReturnType<
  MultiProtocolProvider['getSolanaWeb3Provider']
>;

describe('squads provider bridge', () => {
  it('returns the same provider for valid solana connection', () => {
    const provider = new Connection('http://localhost:8899');
    expect(toSquadsProvider(provider as SolanaProvider)).to.equal(provider);
  });

  it('throws for malformed provider values', () => {
    expect(() => toSquadsProvider({} as SolanaProvider)).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got undefined (provider: object)',
    );
  });

  it('throws when getAccountInfo exists but is not callable', () => {
    expect(() =>
      toSquadsProvider({
        getAccountInfo: 'not-a-function',
      } as unknown as SolanaProvider),
    ).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got string (provider: object)',
    );
  });

  it('labels array getAccountInfo values in malformed provider errors', () => {
    expect(() =>
      toSquadsProvider({
        getAccountInfo: [],
      } as unknown as SolanaProvider),
    ).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got array (provider: object)',
    );
  });

  it('labels null getAccountInfo values in malformed provider errors', () => {
    expect(() =>
      toSquadsProvider({
        getAccountInfo: null,
      } as unknown as SolanaProvider),
    ).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got null (provider: object)',
    );
  });

  it('labels boolean getAccountInfo values in malformed provider errors', () => {
    expect(() =>
      toSquadsProvider({
        getAccountInfo: false,
      } as unknown as SolanaProvider),
    ).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got boolean (provider: object)',
    );
  });

  it('labels object getAccountInfo values in malformed provider errors', () => {
    expect(() =>
      toSquadsProvider({
        getAccountInfo: {},
      } as unknown as SolanaProvider),
    ).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got object (provider: object)',
    );
  });

  it('throws for null malformed provider values', () => {
    expect(() => toSquadsProvider(null as unknown as SolanaProvider)).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got undefined (provider: null)',
    );
  });

  it('throws for undefined malformed provider values', () => {
    expect(() =>
      toSquadsProvider(undefined as unknown as SolanaProvider),
    ).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got undefined (provider: undefined)',
    );
  });
});

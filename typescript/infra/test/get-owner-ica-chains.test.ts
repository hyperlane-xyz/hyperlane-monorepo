import { expect } from 'chai';

import { partitionRequestedChains } from '../scripts/keys/get-owner-ica-chains.js';

describe('partitionRequestedChains', () => {
  // ethereum/arbitrum are EVM; solana/neutron are not.
  const isEvmChain = (chain: string) =>
    ['ethereum', 'arbitrum', 'base', 'tron'].includes(chain);

  it('splits EVM (non-skip) chains into icaChains and the rest into droppedChains', () => {
    const { icaChains, droppedChains } = partitionRequestedChains({
      requestedChains: ['ethereum', 'solana', 'arbitrum', 'neutron'],
      explicitlyRequested: undefined,
      isEvmChain,
      skipList: [],
    });
    expect(icaChains).to.deep.equal(['ethereum', 'arbitrum']);
    expect(droppedChains).to.deep.equal(['solana', 'neutron']);
  });

  it('drops a skip-listed EVM chain', () => {
    const { icaChains, droppedChains } = partitionRequestedChains({
      requestedChains: ['ethereum', 'arbitrum'],
      explicitlyRequested: undefined,
      isEvmChain,
      skipList: ['arbitrum'],
    });
    expect(icaChains).to.deep.equal(['ethereum']);
    expect(droppedChains).to.deep.equal(['arbitrum']);
  });

  it('flags an explicitly-requested non-EVM chain as explicitly dropped', () => {
    const { explicitlyDroppedChains } = partitionRequestedChains({
      requestedChains: ['ethereum', 'solana'],
      explicitlyRequested: new Set(['ethereum', 'solana']),
      isEvmChain,
      skipList: [],
    });
    expect(explicitlyDroppedChains).to.deep.equal(['solana']);
  });

  it('flags an explicitly-requested skip-listed chain as explicitly dropped', () => {
    const { explicitlyDroppedChains } = partitionRequestedChains({
      requestedChains: ['ethereum', 'arbitrum'],
      explicitlyRequested: new Set(['ethereum', 'arbitrum']),
      isEvmChain,
      skipList: ['arbitrum'],
    });
    expect(explicitlyDroppedChains).to.deep.equal(['arbitrum']);
  });

  it('does NOT flag drops from the default full set (no explicit --chains)', () => {
    const { droppedChains, explicitlyDroppedChains } = partitionRequestedChains(
      {
        requestedChains: ['ethereum', 'solana', 'neutron'],
        explicitlyRequested: undefined,
        isEvmChain,
        skipList: [],
      },
    );
    // solana/neutron are dropped, but none are explicitly dropped → run stays benign.
    expect(droppedChains).to.deep.equal(['solana', 'neutron']);
    expect(explicitlyDroppedChains).to.deep.equal([]);
  });
});

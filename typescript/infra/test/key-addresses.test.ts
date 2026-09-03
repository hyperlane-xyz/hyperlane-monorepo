import { expect } from 'chai';

import {
  type KeyAsAddress,
  reconcilePersistedKeyAddresses,
} from '../src/agents/key-addresses.js';

describe('reconcilePersistedKeyAddresses', () => {
  const retired: KeyAsAddress = {
    identifier: 'hyperlane-mainnet3-key-validator-1',
    address: '0xretired',
  };
  const priorRelayer: KeyAsAddress = {
    identifier: 'hyperlane-mainnet3-key-relayer',
    address: '0xold',
  };
  const currentRelayer: KeyAsAddress = {
    ...priorRelayer,
    address: '0xnew',
  };

  it('preserves unreconciled entries during a partial role deployment', () => {
    expect(
      reconcilePersistedKeyAddresses(
        [retired, priorRelayer],
        [currentRelayer],
        true,
      ),
    ).to.deep.equal([retired, currentRelayer]);
  });

  it('removes retired entries during a full reconciliation', () => {
    expect(
      reconcilePersistedKeyAddresses(
        [retired, priorRelayer],
        [currentRelayer],
        false,
      ),
    ).to.deep.equal([currentRelayer]);
  });
});

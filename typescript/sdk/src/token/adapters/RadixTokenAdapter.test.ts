import { expect } from 'chai';
import sinon from 'sinon';

import { RadixProvider } from '@hyperlane-xyz/radix-sdk/runtime';

import { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';

import { RadixTokenAdapter } from './RadixTokenAdapter.js';

describe('RadixTokenAdapter.populateTransferTx', () => {
  const token = 'resource_test';
  const sender = 'account_sender';
  const recipient = 'account_recipient';

  for (const { decimals, atomicAmount, expectedAmount } of [
    { decimals: 18, atomicAmount: 1n, expectedAmount: '0.000000000000000001' },
    {
      decimals: 18,
      atomicAmount: 999999999999999999n,
      expectedAmount: '0.999999999999999999',
    },
    {
      decimals: 18,
      atomicAmount: 1000000000000000001n,
      expectedAmount: '1.000000000000000001',
    },
    {
      decimals: 18,
      atomicAmount: 1234567890123456789n,
      expectedAmount: '1.234567890123456789',
    },
    {
      decimals: 18,
      atomicAmount: 9007199254740993000000000000000001n,
      expectedAmount: '9007199254740993.000000000000000001',
    },
    { decimals: 6, atomicAmount: 1n, expectedAmount: '0.000001' },
    {
      decimals: 6,
      atomicAmount: 9007199254740993n,
      expectedAmount: '9007199254.740993',
    },
    { decimals: 18, atomicAmount: 0n, expectedAmount: '0' },
    { decimals: 18, atomicAmount: 1000000000000000000n, expectedAmount: '1' },
  ]) {
    it(`preserves ${atomicAmount} atomic units with ${decimals} decimals`, async () => {
      const provider = sinon.createStubInstance(RadixProvider);
      provider.getTokenMetadata.resolves({
        name: 'Test',
        symbol: 'TST',
        description: 'Test token',
        decimals,
      });
      const transaction = { networkId: 242, manifest: 'test manifest' };
      provider.getTransferTransaction.resolves(transaction);
      const multiProvider = sinon.createStubInstance(MultiProviderAdapter);
      multiProvider.getRadixProvider.returns(provider);
      const adapter = new RadixTokenAdapter('radixlocal', multiProvider, {
        token,
      });

      const result = await adapter.populateTransferTx({
        weiAmountOrId: atomicAmount,
        recipient,
        fromAccountOwner: sender,
      });

      sinon.assert.calledOnceWithExactly(provider.getTokenMetadata, token);
      sinon.assert.calledOnceWithExactly(provider.getTransferTransaction, {
        signer: sender,
        recipient,
        denom: token,
        amount: expectedAmount,
      });
      expect(result).to.equal(transaction);
    });
  }
});

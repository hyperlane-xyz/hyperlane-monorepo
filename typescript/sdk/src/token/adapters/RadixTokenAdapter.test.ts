import { expect } from 'chai';
import sinon from 'sinon';

import { RadixTokenAdapter } from './RadixTokenAdapter.js';

describe('RadixTokenAdapter', () => {
  it('transfers resources with zero divisibility', async () => {
    const getTransferTransaction = sinon.stub().resolves({});
    const adapter = Object.assign(Object.create(RadixTokenAdapter.prototype), {
      tokenAddress: 'resource_zero_divisibility',
      chainName: 'radixlocal',
      provider: {
        getTokenMetadata: sinon.stub().resolves({
          name: 'Whole Token',
          symbol: 'WHOLE',
          decimals: 0,
        }),
        getTransferTransaction,
      },
    });

    await adapter.populateTransferTx({
      weiAmountOrId: 1n,
      recipient: 'account_recipient',
      fromAccountOwner: 'account_sender',
    });

    expect(getTransferTransaction.calledOnce).to.equal(true);
    expect(getTransferTransaction.firstCall.args[0].amount).to.equal('1');
  });
});

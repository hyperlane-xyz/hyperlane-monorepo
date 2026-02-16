import { expect } from 'chai';
import sinon from 'sinon';

import {
  ISafe__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';

describe('resolveSubmitterBatchesForTransactions missing context default fallback', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('falls back to jsonRpc when multiProvider context is missing', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('does not run inference probes when multiProvider context is missing', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          {
            ...TX,
            from: '0x2222222222222222222222222222222222222222',
          } as any,
        ],
        context: {} as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to jsonRpc when multiProvider.getProtocol getter throws', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        get multiProvider() {
          throw new Error('broken provider context');
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });
});

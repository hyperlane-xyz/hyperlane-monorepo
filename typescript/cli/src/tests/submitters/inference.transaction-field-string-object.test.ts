import { tmpdir } from 'os';

import { expect } from 'chai';
import sinon from 'sinon';

import { ISafe__factory, Ownable__factory } from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions transaction String-object fields', () => {
  const CHAIN = 'anvil2';
  const TARGET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const TX = {
    to: TARGET,
    data: '0xdeadbeef0000',
    chainId: 31338,
  };

  it('applies explicit target override when transaction target is a String object', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-tx-string-object-target-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {
          [TARGET]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: new String(TARGET) } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('applies explicit selector override when transaction data is a String object', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-tx-string-object-data-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {
          [`${TARGET}@0xdeadbeef`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x6666666666666666666666666666666666666666',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, data: new String('0xdeadbeef1122') } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('still infers gnosisSafeTxBuilder when transaction target is a String object', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: new String(TARGET) } as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
            getSignerAddress: async () =>
              '0x4444444444444444444444444444444444444444',
            getProvider: () => ({}),
          },
          registry: {
            getAddresses: async () => ({}),
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(ownableStub.callCount).to.equal(1);
      expect(safeStub.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('infers gnosisSafeTxBuilder from boxed transaction from fallback when target is malformed', async () => {
    const safeAddress = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('owner lookup should not run for malformed target'));
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          {
            ...TX,
            to: 'not-an-evm-address',
            from: new String(safeAddress),
          } as any,
        ],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
            getSignerAddress: async () =>
              '0x4444444444444444444444444444444444444444',
            getProvider: () => ({}),
          },
          registry: {
            getAddresses: async () => ({}),
          },
        } as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });
});

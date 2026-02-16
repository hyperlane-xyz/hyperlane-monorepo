import { tmpdir } from 'os';

import { expect } from 'chai';
import sinon from 'sinon';

import {
  ISafe__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions whitespace strategyUrl fallback', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('treats whitespace strategyUrl as missing and falls back to jsonRpc default', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: '   \n\t ',
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('does not attempt inference probes when strategyUrl is whitespace and context is missing', async () => {
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
        transactions: [TX as any],
        context: {} as any,
        strategyUrl: '   ',
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

  it('treats non-string strategyUrl as missing and falls back to jsonRpc default', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: 123 as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('does not attempt inference probes when strategyUrl is non-string and context is missing', async () => {
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
        transactions: [TX as any],
        context: {} as any,
        strategyUrl: { bad: 'path' } as any,
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

  it('falls back to inference when strategyUrl is non-string and inference context is available', async () => {
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
        transactions: [TX as any],
        context: {
          multiProvider: {
            getProtocol: () => 'ethereum' as any,
            getSignerAddress: async () =>
              '0x4444444444444444444444444444444444444444',
            getProvider: () => ({}),
          },
          registry: {
            getAddresses: async () => ({}),
          },
        } as any,
        strategyUrl: 123 as any,
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

  it('loads explicit strategy when strategyUrl has surrounding whitespace', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-strategy-url-whitespace-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
      },
    });

    let protocolCalls = 0;
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return 'ethereum' as any;
          },
        },
      } as any,
      strategyUrl: `  ${strategyPath}  `,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('loads explicit overrides when strategyUrl has surrounding whitespace', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-strategy-url-whitespace-overrides-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
        },
      },
    });

    let protocolCalls = 0;
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any, { ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return 'ethereum' as any;
          },
        },
      } as any,
      strategyUrl: `  ${strategyPath}  `,
    });

    expect(batches).to.have.length(2);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(1);
  });
});

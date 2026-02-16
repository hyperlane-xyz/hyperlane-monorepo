import { tmpdir } from 'os';

import { expect } from 'chai';
import sinon from 'sinon';

import { Ownable__factory } from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions extended-chain inference bypass', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('does not run inference probes on extended chains without explicit strategy', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run on extended chains'));

    let providerCalls = 0;
    let signerAddressCalls = 0;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
            getProvider: () => {
              providerCalls += 1;
              return {};
            },
            getSignerAddress: async () => {
              signerAddressCalls += 1;
              return '0x4444444444444444444444444444444444444444';
            },
          },
        } as any,
        isExtendedChain: true,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(ownableStub.callCount).to.equal(0);
      expect(providerCalls).to.equal(0);
      expect(signerAddressCalls).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('does not run inference probes on extended chains with explicit strategy file', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-extended-chain-bypass-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
      },
    });

    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run on extended chains'));

    let providerCalls = 0;
    let signerAddressCalls = 0;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
            getProvider: () => {
              providerCalls += 1;
              return {};
            },
            getSignerAddress: async () => {
              signerAddressCalls += 1;
              return '0x4444444444444444444444444444444444444444';
            },
          },
        } as any,
        strategyUrl: strategyPath,
        isExtendedChain: true,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(ownableStub.callCount).to.equal(0);
      expect(providerCalls).to.equal(0);
      expect(signerAddressCalls).to.equal(0);
    } finally {
      ownableStub.restore();
    }
  });

  it('bypasses protocol lookup on extended chains and still returns jsonRpc default batches', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any, { ...TX, data: '0xdeadbeef' } as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            throw new Error(
              'protocol lookup should not run on extended chains',
            );
          },
        },
      } as any,
      isExtendedChain: true,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[0].transactions).to.deep.equal([
      TX as any,
      { ...TX, data: '0xdeadbeef' } as any,
    ]);
  });

  it('does not require multiProvider context on extended chains', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      isExtendedChain: true,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[0].transactions).to.deep.equal([TX as any]);
  });
});

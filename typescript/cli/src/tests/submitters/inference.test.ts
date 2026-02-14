import { tmpdir } from 'os';

import { expect } from 'chai';
import sinon from 'sinon';

import {
  ISafe__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';

import { ProtocolType, TxSubmitterType } from '@hyperlane-xyz/sdk';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions', () => {
  const CHAIN = 'anvil2';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('uses explicit strategy when provided', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-${Date.now()}.yaml`;
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

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any, TX as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[0].transactions).to.have.length(2);
  });

  it('routes transactions using explicit per-target submitter overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-${Date.now()}.yaml`;
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
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txDefault = TX;
    const txOverride = { ...TX, to: overrideTarget };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txDefault as any, txOverride as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(2);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves transaction order by splitting non-contiguous explicit submitter matches', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-overrides-order-${Date.now()}.yaml`;
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
            safeAddress: '0x8888888888888888888888888888888888888888',
            version: '1.0',
          },
        },
      },
    });

    const txDefaultFirst = { ...TX, to: '0x1111111111111111111111111111111111111111' };
    const txOverride = { ...TX, to: overrideTarget };
    const txDefaultLast = { ...TX, to: '0x2222222222222222222222222222222222222222' };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        txDefaultFirst as any,
        txOverride as any,
        txDefaultLast as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(3);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[2].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[0].transactions).to.deep.equal([txDefaultFirst as any]);
    expect(batches[1].transactions).to.deep.equal([txOverride as any]);
    expect(batches[2].transactions).to.deep.equal([txDefaultLast as any]);
  });

  it('prioritizes selector-specific override over target override', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-overrides-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
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
          [`${overrideTarget}@0xdeadbeef`]: {
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

    const txWithSelector = {
      ...TX,
      to: overrideTarget,
      data: '0xdeadbeef0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithSelector as any],
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

  it('ignores invalid override keys and falls back to default explicit submitter', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-invalid-overrides-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          'not-an-address@invalid-selector': {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
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

  it('falls back to default explicit submitter for malformed transaction target', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-malformed-target-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {
          '0x1111111111111111111111111111111111111111': {
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
      transactions: [{ ...TX, to: 'not-an-evm-address' } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('matches selector-specific override with mixed-case selector and target address', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-case-${Date.now()}.yaml`;
    const overrideTarget = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [`${overrideTarget}@0xDeAdBeEf`]: {
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

    const txWithSelector = {
      ...TX,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      data: '0xdeadbeef0000',
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithSelector as any],
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

  it('falls back to jsonRpc when inference fails', async () => {
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to jsonRpc when inference throws on malformed transaction target', async () => {
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: 'not-an-evm-address' } as any],
      context,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('ignores explicit strategy on extended chains', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-extended-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x3333333333333333333333333333333333333333',
          version: '1.0',
        },
      },
    });

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context,
      strategyUrl: strategyPath,
      isExtendedChain: true,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('uses default jsonRpc for non-ethereum chains', async () => {
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.CosmosNative,
      },
    } as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('routes same-chain transactions to different inferred submitters', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const txSignerOwned = {
      ...TX,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const txSafeOwned = {
      ...TX,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () =>
            targetAddress.toLowerCase() === txSignerOwned.to.toLowerCase()
              ? SIGNER
              : safeOwner,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [txSignerOwned as any, txSafeOwned as any],
        context,
      });

      expect(batches).to.have.length(2);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(batches[1].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(batches[0].transactions).to.deep.equal([txSignerOwned as any]);
      expect(batches[1].transactions).to.deep.equal([txSafeOwned as any]);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('preserves transaction order by splitting non-contiguous inferred submitter matches', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const txSignerFirst = {
      ...TX,
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const txSafeOwned = {
      ...TX,
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const txSignerLast = {
      ...TX,
      to: '0xcccccccccccccccccccccccccccccccccccccccc',
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () =>
            targetAddress.toLowerCase() === txSafeOwned.to.toLowerCase()
              ? safeOwner
              : SIGNER,
        }) as any,
    );
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== safeOwner.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [
          txSignerFirst as any,
          txSafeOwned as any,
          txSignerLast as any,
        ],
        context,
      });

      expect(batches).to.have.length(3);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(batches[1].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(batches[2].config.submitter.type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(batches[0].transactions).to.deep.equal([txSignerFirst as any]);
      expect(batches[1].transactions).to.deep.equal([txSafeOwned as any]);
      expect(batches[2].transactions).to.deep.equal([txSignerLast as any]);
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('uses transaction from as fallback inference source when ownable read fails', async () => {
    const fromSafe = '0x4444444444444444444444444444444444444444';
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('not ownable'));
    const safeStub = sinon.stub(ISafe__factory, 'connect').callsFake(
      (address: string) => {
        if (address.toLowerCase() !== fromSafe.toLowerCase()) {
          throw new Error('not safe');
        }

        return {
          getThreshold: async () => 1,
          nonce: async () => 0,
        } as any;
      },
    );

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => ({}),
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, from: fromSafe } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
    } finally {
      ownableStub.restore();
      safeStub.restore();
    }
  });

  it('caches timelock proposer inference per chain and timelock', async () => {
    const timelockOwner = '0x5555555555555555555555555555555555555555';
    const tx1 = { ...TX, to: '0xabababababababababababababababababababab' };
    const tx2 = { ...TX, to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: SIGNER } }),
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [tx1 as any, tx2 as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      // first inference call scans granted+revoked logs, second tx reuses cache
      expect(provider.getLogs.callCount).to.equal(2);
      expect(timelockStub.callCount).to.be.greaterThan(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });
});

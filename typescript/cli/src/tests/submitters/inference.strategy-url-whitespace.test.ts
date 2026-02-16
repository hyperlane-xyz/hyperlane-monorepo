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

  it('treats overlong strategyUrl string as missing and falls back to jsonRpc default', async () => {
    const overlongStrategyUrl = `./${'x'.repeat(5000)}.yaml`;
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: overlongStrategyUrl,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('treats null-byte strategyUrl string as missing and falls back to jsonRpc default', async () => {
    const nullByteStrategyUrl = './bad\0strategy.yaml';
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: nullByteStrategyUrl as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('does not attempt inference probes when strategyUrl is overlong and context is missing', async () => {
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
      const overlongStrategyUrl = `./${'x'.repeat(5000)}.yaml`;
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context: {} as any,
        strategyUrl: overlongStrategyUrl,
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

  it('falls back to inference when strategyUrl is overlong and inference context is available', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);

    try {
      const overlongStrategyUrl = `./${'x'.repeat(5000)}.yaml`;
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
        strategyUrl: overlongStrategyUrl,
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

  it('falls back to inference when strategyUrl contains null byte and inference context is available', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);

    try {
      const nullByteStrategyUrl = './bad\0strategy.yaml';
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
        strategyUrl: nullByteStrategyUrl as any,
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

  it('ignores plain object strategyUrl even when toString returns a valid strategy path', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-strategy-url-plain-object-${Date.now()}.yaml`;
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

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: {
        toString: () => strategyPath,
      } as any,
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

  it('loads explicit strategy when strategyUrl is a String object', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-strategy-url-string-object-${Date.now()}.yaml`;
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
      strategyUrl: new String(` ${strategyPath} `) as any,
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

  it('loads explicit overrides when strategyUrl is a String object', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-strategy-url-string-object-overrides-${Date.now()}.yaml`;
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
      strategyUrl: new String(` ${strategyPath} `) as any,
    });

    expect(batches).to.have.length(2);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(1);
  });

  it('treats whitespace-only String strategyUrl as missing and falls back to jsonRpc default', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: new String('   ') as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('treats String strategyUrl with throwing toString as missing and falls back to jsonRpc default', async () => {
    const badStrategyUrl = new String('ignored') as any;
    badStrategyUrl.toString = () => {
      throw new Error('boom');
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: badStrategyUrl,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('does not attempt inference probes when String strategyUrl toString throws and context is missing', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));

    const badStrategyUrl = new String('ignored') as any;
    badStrategyUrl.toString = () => {
      throw new Error('boom');
    };

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context: {} as any,
        strategyUrl: badStrategyUrl,
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

  it('treats String strategyUrl with non-string toString result as missing and falls back to jsonRpc default', async () => {
    const badStrategyUrl = new String('ignored') as any;
    badStrategyUrl.toString = () => 123 as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: badStrategyUrl,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('treats overlong String strategyUrl as missing and falls back to jsonRpc default', async () => {
    const overlongStringStrategyUrl = new String(
      `./${'x'.repeat(5000)}.yaml`,
    ) as any;
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: overlongStringStrategyUrl,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('treats null-byte String strategyUrl as missing and falls back to jsonRpc default', async () => {
    const nullByteStringStrategyUrl = new String('./bad\0strategy.yaml') as any;
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: nullByteStringStrategyUrl,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to inference when String strategyUrl is overlong and inference context is available', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);

    try {
      const overlongStringStrategyUrl = new String(
        `./${'x'.repeat(5000)}.yaml`,
      ) as any;
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
        strategyUrl: overlongStringStrategyUrl,
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

  it('falls back to inference when String strategyUrl contains null byte and inference context is available', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);

    try {
      const nullByteStringStrategyUrl = new String('./bad\0strategy.yaml') as any;
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
        strategyUrl: nullByteStringStrategyUrl,
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

  it('loads explicit strategy from String strategyUrl when String Symbol.hasInstance throws', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-strategy-url-string-object-hasinstance-${Date.now()}.yaml`;
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

    const originalHasInstanceDescriptor = Object.getOwnPropertyDescriptor(
      String,
      Symbol.hasInstance,
    );
    Object.defineProperty(String, Symbol.hasInstance, {
      configurable: true,
      value: () => {
        throw new Error('String @@hasInstance should not be used');
      },
    });

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context: {
          get multiProvider() {
            throw new Error('multiProvider access should not occur');
          },
        } as any,
        strategyUrl: new String(` ${strategyPath} `) as any,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
    } finally {
      if (originalHasInstanceDescriptor) {
        Object.defineProperty(
          String,
          Symbol.hasInstance,
          originalHasInstanceDescriptor,
        );
      } else {
        delete (String as any)[Symbol.hasInstance];
      }
    }
  });

  it('treats cyclic-prototype proxy strategyUrl as missing and falls back to jsonRpc default', async () => {
    let cyclicProxy: any;
    cyclicProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => cyclicProxy,
      },
    );

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: cyclicProxy,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('treats deep-prototype string-like strategyUrl as missing and falls back to jsonRpc default', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-deep-prototype-string-like-strategy-${Date.now()}.yaml`;
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

    let prototype: object = String.prototype;
    for (let i = 0; i < 200; i += 1) {
      prototype = Object.create(prototype);
    }
    const deepPrototypeStringLike = Object.create(prototype) as any;
    deepPrototypeStringLike.toString = () => strategyPath;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: deepPrototypeStringLike,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to inference when strategyUrl is deep-prototype string-like and inference context is available', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);

    let prototype: object = String.prototype;
    for (let i = 0; i < 200; i += 1) {
      prototype = Object.create(prototype);
    }
    const deepPrototypeStringLike = Object.create(prototype) as any;
    deepPrototypeStringLike.toString = () =>
      `${tmpdir()}/should-not-load-deep-prototype-strategy.yaml`;

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
        strategyUrl: deepPrototypeStringLike,
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

  it('treats getPrototypeOf-throwing strategyUrl proxy as missing and falls back to jsonRpc default', async () => {
    const throwingPrototypeProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('prototype trap should not crash strategy normalization');
        },
      },
    );

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: throwingPrototypeProxy as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to inference when strategyUrl getPrototypeOf trap throws and inference context is available', async () => {
    const safeOwner = '0x2222222222222222222222222222222222222222';
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => safeOwner,
    } as any);
    const safeStub = sinon.stub(ISafe__factory, 'connect').returns({
      getThreshold: async () => 1,
      nonce: async () => 0,
    } as any);
    const throwingPrototypeProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('prototype trap should not crash strategy normalization');
        },
      },
    );

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
        strategyUrl: throwingPrototypeProxy as any,
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

  it('treats forged String-prototype strategyUrl object as missing and falls back to jsonRpc default', async () => {
    const forgedStrategyUrl = Object.create(String.prototype) as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: forgedStrategyUrl,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });
});

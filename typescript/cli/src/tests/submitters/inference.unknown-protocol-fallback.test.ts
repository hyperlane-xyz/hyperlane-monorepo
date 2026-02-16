import { tmpdir } from 'os';

import { expect } from 'chai';
import sinon from 'sinon';

import {
  ISafe__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions unknown protocol fallback', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('falls back to jsonRpc when protocol lookup returns unknown protocol without explicit strategy', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => 'unknown-protocol' as any,
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to explicit default when protocol lookup returns unknown protocol with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-unknown-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x3333333333333333333333333333333333333333',
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
      transactions: [TX as any, { ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => 'unknown-protocol' as any,
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

  it('does not attempt inference when protocol lookup returns unknown protocol with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-unknown-no-probes-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          '0x9999999999999999999999999999999999999999': {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x3333333333333333333333333333333333333333',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
        },
      },
    });

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
        context: {
          multiProvider: {
            getProtocol: () => 'unknown-protocol' as any,
          },
        } as any,
        strategyUrl: strategyPath,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
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

  it('falls back to jsonRpc when protocol lookup returns a promise value without explicit strategy', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => Promise.resolve('ethereum') as any,
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to explicit default when protocol lookup returns a promise value with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-promise-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x3333333333333333333333333333333333333333',
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
      transactions: [TX as any, { ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => Promise.resolve('ethereum') as any,
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

  it('falls back to jsonRpc when protocol lookup returns ProtocolType.Unknown without explicit strategy', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Unknown,
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to explicit default when protocol lookup returns ProtocolType.Unknown with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-unknown-enum-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x3333333333333333333333333333333333333333',
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
      transactions: [TX as any, { ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Unknown,
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

  it('applies explicit overrides when protocol lookup returns uppercase protocol string', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-uppercase-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => 'ETHEREUM' as any,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('applies explicit overrides when protocol lookup returns whitespace-padded protocol string', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-whitespace-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => '  ethereum  ' as any,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('applies explicit overrides when protocol lookup returns boxed uppercase protocol string', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-boxed-uppercase-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => new String(' ETHEREUM ') as any,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to jsonRpc when boxed protocol value toString throws without explicit strategy', async () => {
    const badProtocolValue = new String('ethereum') as any;
    badProtocolValue.toString = () => {
      throw new Error('boom');
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => badProtocolValue,
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to explicit default when boxed protocol value toString throws with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-boxed-throwing-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const badProtocolValue = new String('ethereum') as any;
    badProtocolValue.toString = () => {
      throw new Error('boom');
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => badProtocolValue,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('falls back to jsonRpc when boxed protocol value toString returns non-string without explicit strategy', async () => {
    const badProtocolValue = new String('ethereum') as any;
    badProtocolValue.toString = () => 123 as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => badProtocolValue,
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to explicit default when boxed protocol value toString returns non-string with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-boxed-non-string-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const badProtocolValue = new String('ethereum') as any;
    badProtocolValue.toString = () => 123 as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => badProtocolValue,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('applies explicit overrides from boxed protocol string when String Symbol.hasInstance throws', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-boxed-hasinstance-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
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
        transactions: [{ ...TX, to: overrideTarget } as any],
        context: {
          multiProvider: {
            getProtocol: () => new String(' ETHEREUM ') as any,
          },
        } as any,
        strategyUrl: strategyPath,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
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

  it('falls back to explicit default when protocol lookup returns cyclic-prototype proxy with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-cyclic-proxy-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    let cyclicProxy: any;
    cyclicProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => cyclicProxy,
      },
    );

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => cyclicProxy,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('falls back to jsonRpc when protocol lookup returns overlong string without explicit strategy', async () => {
    const overlongProtocol = `${'ethereum'.repeat(100)}-overflow`;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => overlongProtocol as any,
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to explicit default when protocol lookup returns overlong string with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-overlong-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });
    const overlongProtocol = `${'ethereum'.repeat(100)}-overflow`;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => overlongProtocol as any,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('falls back to jsonRpc when protocol lookup returns overlong boxed string without explicit strategy', async () => {
    const overlongBoxedProtocol = new String(
      `${'ethereum'.repeat(100)}-overflow`,
    ) as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => overlongBoxedProtocol,
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to explicit default when protocol lookup returns overlong boxed string with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-overlong-boxed-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });
    const overlongBoxedProtocol = new String(
      `${'ethereum'.repeat(100)}-overflow`,
    ) as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => overlongBoxedProtocol,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('falls back to explicit default when protocol lookup returns deep-prototype string-like object with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-deep-prototype-string-like-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    let prototype: object = String.prototype;
    for (let i = 0; i < 200; i += 1) {
      prototype = Object.create(prototype);
    }
    const deepPrototypeStringLike = Object.create(prototype) as any;
    deepPrototypeStringLike.toString = () => 'ethereum';

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => deepPrototypeStringLike,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });
});

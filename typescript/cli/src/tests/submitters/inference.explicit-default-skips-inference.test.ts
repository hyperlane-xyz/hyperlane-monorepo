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

describe('resolveSubmitterBatchesForTransactions explicit default skips inference', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  const createExplicitStrategyPath = () => {
    const strategyPath = `${tmpdir()}/submitter-inference-explicit-default-skips-inference-${Date.now()}.yaml`;
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
    return strategyPath;
  };

  const createExplicitStrategyWithOverridePath = () => {
    const strategyPath = `${tmpdir()}/submitter-inference-explicit-default-with-override-${Date.now()}.yaml`;
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
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });
    return strategyPath;
  };

  const createExplicitStrategyWithEmptyOverridePath = () => {
    const strategyPath = `${tmpdir()}/submitter-inference-explicit-default-with-empty-override-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {},
      },
    });
    return strategyPath;
  };

  const createExplicitStrategyWithWhitespaceOverrideKeyPath = () => {
    const strategyPath = `${tmpdir()}/submitter-inference-explicit-default-with-whitespace-override-key-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {
          '   ': {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });
    return strategyPath;
  };

  const createExplicitStrategyWithNullByteOverrideKeyPath = () => {
    const strategyPath = `${tmpdir()}/submitter-inference-explicit-default-with-null-byte-override-key-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {
          '0x1111111111111111111111111111111111111111\0': {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });
    return strategyPath;
  };

  const createExplicitStrategyWithOverlongOverrideKeyPath = () => {
    const strategyPath = `${tmpdir()}/submitter-inference-explicit-default-with-overlong-override-key-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {
          [`0x${'1'.repeat(5000)}`]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });
    return strategyPath;
  };

  it('does not look up protocol when explicit strategy has no overrides', async () => {
    let protocolCalls = 0;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not access multiProvider when explicit strategy has no overrides', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        get multiProvider() {
          throw new Error('multiProvider access should not occur');
        },
      } as any,
      strategyUrl: createExplicitStrategyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('returns empty batches without protocol lookup when explicit strategy has overrides and no transactions', async () => {
    let protocolCalls = 0;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.deep.equal([]);
    expect(protocolCalls).to.equal(0);
  });

  it('still looks up protocol when explicit strategy has overrides', async () => {
    let protocolCalls = 0;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(protocolCalls).to.equal(1);
  });

  it('does not look up protocol when explicit strategy has overrides but no transactions have usable targets', async () => {
    let protocolCalls = 0;
    const transactions = [
      { ...TX, to: undefined },
      { ...TX, to: '   ' },
      { ...TX, to: 123 as any },
    ];

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: transactions as any,
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not require multiProvider context when explicit strategy has overrides but no transactions have usable targets', async () => {
    const transactions = [
      { ...TX, to: undefined },
      { ...TX, to: '   ' },
      { ...TX, to: 123 as any },
    ];

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: transactions as any,
      context: {} as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('does not look up protocol when explicit strategy has overrides but transaction target contains null byte', async () => {
    let protocolCalls = 0;
    const transactions = [{ ...TX, to: '0x1111111111111111111111111111111111111111\0' }];

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: transactions as any,
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not access multiProvider when explicit strategy has overrides but boxed transaction target contains null byte', async () => {
    const boxedNullByteTarget = new String(
      '0x1111111111111111111111111111111111111111\0',
    ) as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: boxedNullByteTarget } as any],
      context: {
        get multiProvider() {
          throw new Error('multiProvider access should not occur');
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('does not look up protocol when explicit strategy has overrides but transaction target getter throws', async () => {
    let protocolCalls = 0;
    const throwingTargetTx = {
      ...TX,
      get to() {
        throw new Error('target getter should not crash explicit fallback');
      },
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [throwingTargetTx as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not attempt inference when explicit strategy has overrides but transaction target getter throws', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));

    const throwingTargetTx = {
      ...TX,
      get to() {
        throw new Error('target getter should not crash explicit fallback');
      },
    };

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [throwingTargetTx as any],
        context: {
          get multiProvider() {
            throw new Error('multiProvider access should not occur');
          },
        } as any,
        strategyUrl: createExplicitStrategyWithOverridePath(),
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

  it('does not look up protocol when explicit strategy has overrides but boxed transaction target toString throws', async () => {
    let protocolCalls = 0;
    const boxedTarget = new String(
      '0x1111111111111111111111111111111111111111',
    ) as any;
    boxedTarget.toString = () => {
      throw new Error('boxed target toString should not crash explicit fallback');
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: boxedTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not attempt inference when explicit strategy has overrides but boxed transaction target toString throws', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    const boxedTarget = new String(
      '0x1111111111111111111111111111111111111111',
    ) as any;
    boxedTarget.toString = () => {
      throw new Error('boxed target toString should not crash explicit fallback');
    };

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: boxedTarget } as any],
        context: {
          get multiProvider() {
            throw new Error('multiProvider access should not occur');
          },
        } as any,
        strategyUrl: createExplicitStrategyWithOverridePath(),
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

  it('does not look up protocol when explicit strategy has overrides but boxed transaction target toString returns non-string', async () => {
    let protocolCalls = 0;
    const boxedTarget = new String(
      '0x1111111111111111111111111111111111111111',
    ) as any;
    boxedTarget.toString = () => 123 as any;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: boxedTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not attempt inference when explicit strategy has overrides but boxed transaction target toString returns non-string', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    const boxedTarget = new String(
      '0x1111111111111111111111111111111111111111',
    ) as any;
    boxedTarget.toString = () => 123 as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: boxedTarget } as any],
        context: {
          get multiProvider() {
            throw new Error('multiProvider access should not occur');
          },
        } as any,
        strategyUrl: createExplicitStrategyWithOverridePath(),
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

  it('does not access multiProvider when explicit strategy has overrides but no transactions have usable targets', async () => {
    const transactions = [
      { ...TX, to: undefined },
      { ...TX, to: '   ' },
      { ...TX, to: 123 as any },
    ];

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: transactions as any,
      context: {
        get multiProvider() {
          throw new Error('multiProvider access should not occur');
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('does not attempt inference when explicit strategy has overrides but no transactions have usable targets', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    let protocolCalls = 0;

    try {
      const transactions = [
        { ...TX, to: undefined },
        { ...TX, to: '   ' },
        { ...TX, to: 123 as any },
      ];

      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: transactions as any,
        context: {
          multiProvider: {
            getProtocol: () => {
              protocolCalls += 1;
              return ProtocolType.Ethereum;
            },
          },
        } as any,
        strategyUrl: createExplicitStrategyWithOverridePath(),
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(protocolCalls).to.equal(0);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('does not look up protocol when explicit strategy has empty overrides object', async () => {
    let protocolCalls = 0;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithEmptyOverridePath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not look up protocol when explicit strategy has only whitespace override keys', async () => {
    let protocolCalls = 0;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithWhitespaceOverrideKeyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not access multiProvider when explicit strategy has only whitespace override keys', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        get multiProvider() {
          throw new Error('multiProvider access should not occur');
        },
      } as any,
      strategyUrl: createExplicitStrategyWithWhitespaceOverrideKeyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('does not require multiProvider context when explicit strategy has only whitespace override keys', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: createExplicitStrategyWithWhitespaceOverrideKeyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('does not look up protocol when explicit strategy has only null-byte override keys', async () => {
    let protocolCalls = 0;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithNullByteOverrideKeyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not access multiProvider when explicit strategy has only null-byte override keys', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        get multiProvider() {
          throw new Error('multiProvider access should not occur');
        },
      } as any,
      strategyUrl: createExplicitStrategyWithNullByteOverrideKeyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('does not look up protocol when explicit strategy has only overlong override keys', async () => {
    let protocolCalls = 0;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => {
            protocolCalls += 1;
            return ProtocolType.Ethereum;
          },
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverlongOverrideKeyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(protocolCalls).to.equal(0);
  });

  it('does not access multiProvider when explicit strategy has only overlong override keys', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        get multiProvider() {
          throw new Error('multiProvider access should not occur');
        },
      } as any,
      strategyUrl: createExplicitStrategyWithOverlongOverrideKeyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('does not require multiProvider context when explicit strategy has no overrides', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {} as any,
      strategyUrl: createExplicitStrategyPath(),
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('does not attempt inference when target is malformed and transaction from is safe-like', async () => {
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
            to: 'not-an-evm-address',
            from: '0x4444444444444444444444444444444444444444',
          } as any,
        ],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
        strategyUrl: createExplicitStrategyPath(),
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

  it('does not attempt inference when target is missing and transaction from is safe-like', async () => {
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
            to: undefined,
            from: '0x4444444444444444444444444444444444444444',
          } as any,
        ],
        context: {
          multiProvider: {
            getProtocol: () => ProtocolType.Ethereum,
          },
        } as any,
        strategyUrl: createExplicitStrategyPath(),
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

  it('does not attempt inference when protocol lookup fails but explicit strategy is present', async () => {
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
            to: 'not-an-evm-address',
            from: '0x4444444444444444444444444444444444444444',
          } as any,
        ],
        context: {
          multiProvider: {
            getProtocol: () => {
              throw new Error('protocol lookup failed');
            },
          },
        } as any,
        strategyUrl: createExplicitStrategyPath(),
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

  it('falls back to explicit default when protocol lookup fails and explicit strategy has overrides', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    let protocolCalls = 0;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context: {
          multiProvider: {
            getProtocol: () => {
              protocolCalls += 1;
              throw new Error('protocol lookup failed');
            },
          },
        } as any,
        strategyUrl: createExplicitStrategyWithOverridePath(),
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(protocolCalls).to.equal(1);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to explicit default when protocol lookup returns undefined and explicit strategy has overrides', async () => {
    const ownableStub = sinon
      .stub(Ownable__factory, 'connect')
      .throws(new Error('ownable probe should not run'));
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('safe probe should not run'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('timelock probe should not run'));
    let protocolCalls = 0;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context: {
          multiProvider: {
            getProtocol: () => {
              protocolCalls += 1;
              return undefined;
            },
          },
        } as any,
        strategyUrl: createExplicitStrategyWithOverridePath(),
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(protocolCalls).to.equal(1);
      expect(ownableStub.callCount).to.equal(0);
      expect(safeStub.callCount).to.equal(0);
      expect(timelockStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  });

  it('falls back to explicit default when multiProvider context is missing and explicit strategy has overrides', async () => {
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
        strategyUrl: createExplicitStrategyWithOverridePath(),
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
});

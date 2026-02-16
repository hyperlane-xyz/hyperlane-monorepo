import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions EVM malformed target default preservation', () => {
  const CHAIN = 'anvil2';
  const TARGET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const TX = {
    to: TARGET,
    data: '0x',
    chainId: 31338,
  };

  const GNOSIS_DEFAULT_SUBMITTER = {
    type: TxSubmitterType.GNOSIS_TX_BUILDER,
    chain: CHAIN,
    safeAddress: '0x7777777777777777777777777777777777777777',
    version: '1.0',
  } as const;

  const JSON_RPC_OVERRIDE_SUBMITTER = {
    type: TxSubmitterType.JSON_RPC,
    chain: CHAIN,
  } as const;

  const createStrategyPath = (suffix: string) =>
    `${tmpdir()}/submitter-inference-malformed-target-preserve-default-${suffix}-${Date.now()}.yaml`;

  const writeTargetOverrideStrategy = (strategyPath: string) =>
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [TARGET]: JSON_RPC_OVERRIDE_SUBMITTER,
        },
      },
    });

  const resolveSingleBatch = async (
    transaction: unknown,
    strategyPath: string,
  ) =>
    resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [transaction as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

  const resolveBatches = async (
    transactions: unknown[],
    strategyPath: string,
  ) =>
    resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: transactions as any,
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

  it('preserves explicit default submitter when transaction target is non-string', async () => {
    const strategyPath = createStrategyPath('non-string');
    writeTargetOverrideStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: 12345 as any },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when transaction target is malformed EVM address', async () => {
    const strategyPath = createStrategyPath('malformed-address');
    writeTargetOverrideStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: 'not-an-evm-address' },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when transaction target is whitespace-only', async () => {
    const strategyPath = createStrategyPath('whitespace-only-target');
    writeTargetOverrideStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: '   ' },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when transaction target getter throws', async () => {
    const strategyPath = createStrategyPath('throwing-target-getter');
    writeTargetOverrideStrategy(strategyPath);

    const txWithThrowingTargetGetter = {
      ...TX,
      get to() {
        throw new Error('target getter should not crash explicit override routing');
      },
    };

    const batches = await resolveSingleBatch(
      txWithThrowingTargetGetter,
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('still applies valid EVM target override when transaction target is well-formed', async () => {
    const strategyPath = createStrategyPath('valid-address');
    writeTargetOverrideStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: TARGET },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('still applies valid EVM target override when transaction target is whitespace-padded uppercase 0X address', async () => {
    const strategyPath = createStrategyPath('well-formed-uppercase-padded');
    writeTargetOverrideStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: `  0X${TARGET.slice(2).toUpperCase()}  ` },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('still applies valid EVM target override when transaction data getter throws', async () => {
    const strategyPath = createStrategyPath('throwing-data-getter');
    writeTargetOverrideStrategy(strategyPath);

    const txWithThrowingDataGetter = {
      ...TX,
      get data() {
        throw new Error('data getter should not crash target override routing');
      },
    };

    const batches = await resolveSingleBatch(
      txWithThrowingDataGetter,
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('still applies valid EVM target override when boxed transaction data toString throws', async () => {
    const strategyPath = createStrategyPath('boxed-throwing-data-tostring');
    writeTargetOverrideStrategy(strategyPath);

    const boxedData = new String('0xdeadbeef') as any;
    boxedData.toString = () => {
      throw new Error('boxed data toString should not crash target override routing');
    };

    const batches = await resolveSingleBatch(
      { ...TX, data: boxedData },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('still applies valid EVM target override when boxed transaction data toString returns non-string', async () => {
    const strategyPath = createStrategyPath('boxed-non-string-data-tostring');
    writeTargetOverrideStrategy(strategyPath);

    const boxedData = new String('0xdeadbeef') as any;
    boxedData.toString = () => 123 as any;

    const batches = await resolveSingleBatch(
      { ...TX, data: boxedData },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('still applies valid EVM target override when transaction data has overlong leading whitespace before selector', async () => {
    const strategyPath = createStrategyPath('overlong-leading-whitespace-data');
    writeTargetOverrideStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, data: `${' '.repeat(2000)}0xdeadbeef0000` },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('still applies valid EVM target override when boxed transaction data has overlong leading whitespace before selector', async () => {
    const strategyPath = createStrategyPath(
      'boxed-overlong-leading-whitespace-data',
    );
    writeTargetOverrideStrategy(strategyPath);
    const boxedData = new String(`${' '.repeat(2000)}0xdeadbeef0000`) as any;

    const batches = await resolveSingleBatch(
      { ...TX, data: boxedData },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('routes valid targets while preserving default for transactions with throwing target getters', async () => {
    const strategyPath = createStrategyPath('mixed-valid-and-throwing-target');
    writeTargetOverrideStrategy(strategyPath);

    const txWithThrowingTargetGetter = {
      ...TX,
      data: '0x1234',
      get to() {
        throw new Error('target getter should not crash explicit override routing');
      },
    };

    const batches = await resolveBatches(
      [{ ...TX, data: '0xabcdef', to: TARGET }, txWithThrowingTargetGetter],
      strategyPath,
    );

    expect(batches).to.have.length(2);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[0].transactions).to.have.length(1);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[1].transactions).to.have.length(1);
  });
});

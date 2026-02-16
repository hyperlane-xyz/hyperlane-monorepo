import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions EVM malformed target selector-only default preservation', () => {
  const CHAIN = 'anvil2';
  const TARGET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const TX = {
    to: TARGET,
    data: '0xdeadbeef0000',
    chainId: 31338,
  };

  const GNOSIS_DEFAULT_SUBMITTER = {
    type: TxSubmitterType.GNOSIS_TX_BUILDER,
    chain: CHAIN,
    safeAddress: '0x7777777777777777777777777777777777777777',
    version: '1.0',
  } as const;

  const createStrategyPath = (suffix: string) =>
    `${tmpdir()}/submitter-inference-selector-only-malformed-target-preserve-default-${suffix}-${Date.now()}.yaml`;

  const writeSelectorOnlyStrategy = (strategyPath: string) =>
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
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

  it('preserves explicit default submitter when transaction target is non-string and only selector override exists', async () => {
    const strategyPath = createStrategyPath('non-string-target');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: 12345 as any },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when transaction target is malformed EVM address and only selector override exists', async () => {
    const strategyPath = createStrategyPath('malformed-target');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: 'not-an-evm-address' },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when transaction target is whitespace-only and only selector override exists', async () => {
    const strategyPath = createStrategyPath('whitespace-only-target');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: '   ' },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when transaction data getter throws and only selector override exists', async () => {
    const strategyPath = createStrategyPath('throwing-data-getter');
    writeSelectorOnlyStrategy(strategyPath);

    const txWithThrowingDataGetter = {
      ...TX,
      get data() {
        throw new Error('data getter should not crash selector override routing');
      },
    };

    const batches = await resolveSingleBatch(
      txWithThrowingDataGetter,
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when boxed transaction data toString throws and only selector override exists', async () => {
    const strategyPath = createStrategyPath('boxed-throwing-data-tostring');
    writeSelectorOnlyStrategy(strategyPath);

    const boxedData = new String('0xdeadbeef') as any;
    boxedData.toString = () => {
      throw new Error('boxed data toString should not crash selector override routing');
    };

    const batches = await resolveSingleBatch(
      { ...TX, data: boxedData },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when boxed transaction data toString returns non-string and only selector override exists', async () => {
    const strategyPath = createStrategyPath('boxed-non-string-data-tostring');
    writeSelectorOnlyStrategy(strategyPath);

    const boxedData = new String('0xdeadbeef') as any;
    boxedData.toString = () => 123 as any;

    const batches = await resolveSingleBatch(
      { ...TX, data: boxedData },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when selector data is overlong malformed payload and only selector override exists', async () => {
    const strategyPath = createStrategyPath('selector-overlong-malformed-payload');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, data: `0xzzzzzzzz${'ab'.repeat(10000)}` },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when selector data has overlong leading whitespace and only selector override exists', async () => {
    const strategyPath = createStrategyPath(
      'selector-overlong-leading-whitespace',
    );
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, data: `${' '.repeat(2000)}0xdeadbeef0000` },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('still applies selector-specific override when transaction target is well-formed', async () => {
    const strategyPath = createStrategyPath('well-formed-target');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: TARGET },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('still applies selector-specific override when transaction target is whitespace-padded uppercase 0X address', async () => {
    const strategyPath = createStrategyPath('well-formed-uppercase-padded');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, to: `  0X${TARGET.slice(2).toUpperCase()}  ` },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });

  it('still applies selector-specific override when transaction data has whitespace-padded uppercase selector and overlong payload', async () => {
    const strategyPath = createStrategyPath('selector-uppercase-overlong-payload');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      {
        ...TX,
        data: `   0XDEADBEEF${'ab'.repeat(10000)}`,
      },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
  });
});

import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions EVM malformed selector-data default preservation', () => {
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

  const createStrategyPath = (suffix: string) =>
    `${tmpdir()}/submitter-inference-selector-malformed-data-preserve-default-${suffix}-${Date.now()}.yaml`;

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

  it('preserves explicit default submitter when transaction data is non-string and only selector override exists', async () => {
    const strategyPath = createStrategyPath('non-string');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, data: 42 as any },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when transaction data lacks full selector and only selector override exists', async () => {
    const strategyPath = createStrategyPath('short-selector');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, data: '0xdeadbee' },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when transaction data is empty hex and only selector override exists', async () => {
    const strategyPath = createStrategyPath('empty-hex');
    writeSelectorOnlyStrategy(strategyPath);

    const batches = await resolveSingleBatch(
      { ...TX, data: '0x' },
      strategyPath,
    );

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });
});

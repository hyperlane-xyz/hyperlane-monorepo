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
});

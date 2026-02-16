import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions non-EVM selector-key filtering', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: 'cosmos1defaultaddress0000000000000000000000000',
    data: '0x',
    chainId: 31338,
  };

  const GNOSIS_DEFAULT_SUBMITTER = {
    type: TxSubmitterType.GNOSIS_TX_BUILDER,
    chain: CHAIN,
    safeAddress: '0x8888888888888888888888888888888888888888',
    version: '1.0',
  } as const;

  it('preserves explicit default submitter when only selector-style non-EVM override keys are provided', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-selector-only-default-preservation-${Date.now()}.yaml`;
    const selectorStyleTarget =
      'cosmos1overrideaddress000000000000000000000000@0xdeadbeef';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [selectorStyleTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x9999999999999999999999999999999999999999',
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
      transactions: [{ ...TX, to: selectorStyleTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when malformed selector-style non-EVM keys are provided', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-malformed-selector-only-default-preservation-${Date.now()}.yaml`;
    const malformedSelectorStyleTarget =
      'cosmos1overrideaddress000000000000000000000000@0xdeadbeef@extra';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [malformedSelectorStyleTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x9999999999999999999999999999999999999999',
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
      transactions: [{ ...TX, to: malformedSelectorStyleTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('applies valid non-EVM target overrides while ignoring selector-style keys in the same strategy', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-mixed-selector-filtering-${Date.now()}.yaml`;
    const validOverrideTarget = 'cosmos1validoverride000000000000000000000000';
    const selectorStyleTarget = `${validOverrideTarget}@0xdeadbeef`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [selectorStyleTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x9999999999999999999999999999999999999999',
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN,
            },
          },
          [validOverrideTarget]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        { ...TX, to: selectorStyleTarget } as any,
        { ...TX, to: validOverrideTarget } as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(2);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[1].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });
});

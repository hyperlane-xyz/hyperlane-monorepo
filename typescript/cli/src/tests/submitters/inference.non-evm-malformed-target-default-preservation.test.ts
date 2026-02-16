import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions non-EVM malformed target default preservation', () => {
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

  const NON_EVM_OVERRIDE_TARGET =
    'cosmos1overrideaddress000000000000000000000000';

  it('preserves explicit default submitter when non-EVM transaction target is non-string', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-non-string-target-preserve-default-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [NON_EVM_OVERRIDE_TARGET]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: 12345 as any } as any],
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

  it('preserves explicit default submitter when non-EVM transaction target is whitespace-only', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-whitespace-target-preserve-default-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [NON_EVM_OVERRIDE_TARGET]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: '   ' } as any],
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

  it('still applies valid non-EVM target override when transaction target is well-formed', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-valid-target-override-with-default-preservation-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [NON_EVM_OVERRIDE_TARGET]: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          },
        },
      },
    });

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [{ ...TX, to: NON_EVM_OVERRIDE_TARGET } as any],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });
});

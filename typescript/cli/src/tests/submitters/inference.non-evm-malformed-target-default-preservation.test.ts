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

  it('preserves explicit default submitter when non-EVM transaction target is overlong string', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-overlong-target-preserve-default-${Date.now()}.yaml`;
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
      transactions: [{ ...TX, to: `cosmos1${'x'.repeat(5000)}` } as any],
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

  it('preserves explicit default submitter when non-EVM transaction target contains null byte', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-null-byte-target-preserve-default-${Date.now()}.yaml`;
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
      transactions: [{ ...TX, to: `${NON_EVM_OVERRIDE_TARGET}\0` } as any],
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

  it('preserves explicit default submitter when non-EVM transaction target getter throws', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-throwing-target-getter-preserve-default-${Date.now()}.yaml`;
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

    const txWithThrowingTargetGetter = {
      ...TX,
      get to() {
        throw new Error('target getter should not crash non-EVM override routing');
      },
    };

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithThrowingTargetGetter as any],
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

  it('still applies valid non-EVM target override when transaction target is a String object', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-valid-target-string-object-override-${Date.now()}.yaml`;
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
      transactions: [{ ...TX, to: new String(NON_EVM_OVERRIDE_TARGET) } as any],
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

  it('routes valid non-EVM targets while preserving default for overlong targets', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-cosmos-mixed-valid-overlong-target-default-preservation-${Date.now()}.yaml`;
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
      transactions: [
        { ...TX, to: NON_EVM_OVERRIDE_TARGET } as any,
        { ...TX, to: `cosmos1${'x'.repeat(5000)}` } as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.CosmosNative,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(2);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[0].transactions).to.have.length(1);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[1].transactions).to.have.length(1);
  });
});

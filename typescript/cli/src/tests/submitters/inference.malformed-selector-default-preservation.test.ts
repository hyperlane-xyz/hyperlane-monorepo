import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions malformed selector default preservation', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  const GNOSIS_DEFAULT_SUBMITTER = {
    type: TxSubmitterType.GNOSIS_TX_BUILDER,
    chain: CHAIN,
    safeAddress: '0x7777777777777777777777777777777777777777',
    version: '1.0',
  } as const;

  it('preserves explicit default submitter when selector override key has extra separators and no target override exists', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-malformed-key-extra-separators-preserve-default-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [`${overrideTarget}@0xdeadbeef@extra`]: {
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

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        { ...TX, to: overrideTarget, data: '0xdeadbeef0000' } as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when selector override key has an empty selector and no target override exists', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-empty-key-preserve-default-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [`${overrideTarget}@`]: {
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

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        { ...TX, to: overrideTarget, data: '0xdeadbeef0000' } as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when selector override key has an empty target and no target override exists', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-empty-target-preserve-default-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          '@0xdeadbeef': {
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

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        { ...TX, to: overrideTarget, data: '0xdeadbeef0000' } as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when selector override key has an invalid EVM target and no target override exists', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-invalid-target-preserve-default-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          'not-an-address@0xdeadbeef': {
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

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        { ...TX, to: overrideTarget, data: '0xdeadbeef0000' } as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });

  it('preserves explicit default submitter when selector override key has malformed selector syntax and no target override exists', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-invalid-selector-syntax-preserve-default-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: GNOSIS_DEFAULT_SUBMITTER,
        submitterOverrides: {
          [`${overrideTarget}@deadbeef`]: {
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

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [
        { ...TX, to: overrideTarget, data: '0xdeadbeef0000' } as any,
      ],
      context: {
        multiProvider: {
          getProtocol: () => ProtocolType.Ethereum,
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

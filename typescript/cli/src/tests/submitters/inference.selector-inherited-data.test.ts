import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions selector inherited data fallback', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('uses target-only override when selector data exists only on prototype', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-inherited-data-target-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN,
            safeAddress: '0x7777777777777777777777777777777777777777',
            version: '1.0',
          },
          [`${overrideTarget}@0xdeadbeef`]: {
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

    const txWithInheritedData = Object.create({
      data: '0xdeadbeef0000',
    });
    txWithInheritedData.to = overrideTarget;
    txWithInheritedData.chainId = TX.chainId;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithInheritedData as any],
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

  it('uses explicit default when selector override data exists only on prototype', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-selector-inherited-data-default-${Date.now()}.yaml`;
    const overrideTarget = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
        submitterOverrides: {
          [`${overrideTarget}@0xdeadbeef`]: {
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

    const txWithInheritedData = Object.create({
      data: '0xdeadbeef0000',
    });
    txWithInheritedData.to = overrideTarget;
    txWithInheritedData.chainId = TX.chainId;

    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [txWithInheritedData as any],
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

import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('resolveSubmitterBatchesForTransactions unknown protocol fallback', () => {
  const CHAIN = 'anvil2';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  it('falls back to jsonRpc when protocol lookup returns unknown protocol without explicit strategy', async () => {
    const batches = await resolveSubmitterBatchesForTransactions({
      chain: CHAIN,
      transactions: [TX as any],
      context: {
        multiProvider: {
          getProtocol: () => 'unknown-protocol' as any,
        },
      } as any,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to explicit default when protocol lookup returns unknown protocol with explicit overrides', async () => {
    const strategyPath = `${tmpdir()}/submitter-inference-protocol-unknown-explicit-${Date.now()}.yaml`;
    const overrideTarget = '0x9999999999999999999999999999999999999999';
    writeYamlOrJson(strategyPath, {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x2222222222222222222222222222222222222222',
          version: '1.0',
        },
        submitterOverrides: {
          [overrideTarget]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN,
            timelockAddress: '0x3333333333333333333333333333333333333333',
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
      transactions: [TX as any, { ...TX, to: overrideTarget } as any],
      context: {
        multiProvider: {
          getProtocol: () => 'unknown-protocol' as any,
        },
      } as any,
      strategyUrl: strategyPath,
    });

    expect(batches).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
    expect(batches[0].transactions).to.have.length(2);
  });
});

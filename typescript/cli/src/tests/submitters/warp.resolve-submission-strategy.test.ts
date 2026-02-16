import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { resolveSubmissionStrategyForChain } from '../../deploy/warp.js';

describe('resolveSubmissionStrategyForChain', () => {
  const CHAIN = 'anvil2';

  const defaultSubmitter = {
    submitter: {
      type: TxSubmitterType.JSON_RPC,
      chain: CHAIN,
    },
  };

  it('uses own chain strategy when present', () => {
    const ownStrategy = {
      submitter: {
        type: TxSubmitterType.GNOSIS_TX_BUILDER,
        chain: CHAIN,
        safeAddress: '0x7777777777777777777777777777777777777777',
        version: '1.0',
      },
    };
    const chainSubmissionStrategies = {
      [CHAIN]: ownStrategy,
    };

    const resolved = resolveSubmissionStrategyForChain({
      chain: CHAIN as any,
      chainSubmissionStrategies: chainSubmissionStrategies as any,
      defaultSubmitter: defaultSubmitter as any,
    });

    expect(resolved).to.equal(ownStrategy);
  });

  it('ignores inherited chain strategy entries', () => {
    const chainSubmissionStrategies = Object.create({
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
      },
    });

    const resolved = resolveSubmissionStrategyForChain({
      chain: CHAIN as any,
      chainSubmissionStrategies: chainSubmissionStrategies as any,
      defaultSubmitter: defaultSubmitter as any,
    });

    expect(resolved).to.equal(defaultSubmitter);
  });

  it('falls back to default for non-object strategy candidates', () => {
    const chainSubmissionStrategies = {
      [CHAIN]: 'invalid',
    };

    const resolved = resolveSubmissionStrategyForChain({
      chain: CHAIN as any,
      chainSubmissionStrategies: chainSubmissionStrategies as any,
      defaultSubmitter: defaultSubmitter as any,
    });

    expect(resolved).to.equal(defaultSubmitter);
  });
});

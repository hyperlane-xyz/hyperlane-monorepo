import sinon from 'sinon';

import {
  EvmHypAevoXERC20Adapter,
  MultiProvider,
  TokenStandard,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';

import { logXERC20Limits } from './warp.js';

describe('logXERC20Limits', () => {
  afterEach(() => sinon.restore());

  it('logs an Aevo router with the limits its adapter states, formatted in the units of its token', async () => {
    sinon
      .stub(EvmHypAevoXERC20Adapter.prototype, 'getMintLimit')
      .resolves(75_000_000n);
    sinon
      .stub(EvmHypAevoXERC20Adapter.prototype, 'getBurnLimit')
      .resolves(30_000_000n);
    const table = sinon.stub(console, 'table');
    const warpCoreConfig: WarpCoreConfig = {
      tokens: [
        {
          chainName: 'test1',
          standard: TokenStandard.EvmHypAevoXERC20,
          addressOrDenom: '0x1111111111111111111111111111111111111111',
          decimals: 6,
          symbol: 'USDC',
          name: 'USDC',
        },
      ],
    };

    await logXERC20Limits(
      warpCoreConfig,
      MultiProvider.createTestMultiProvider(),
    );

    sinon.assert.calledOnceWithExactly(table, {
      test1: { mint: '75.0', burn: '30.0' },
    });
  });
});

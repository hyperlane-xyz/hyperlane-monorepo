import { expect } from 'chai';
import sinon from 'sinon';

import {
  EvmHypAevoXERC20Adapter,
  MultiProvider,
  TokenStandard,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { logXERC20Limits } from './warp.js';

// What a router states, in the 6 decimals of its token, of which the table logs
// the mint and burn limits.
const LIMITS = {
  mint: 75_000_000n,
  mintMax: 100_000_000n,
  burn: 30_000_000n,
  burnMax: 100_000_000n,
};

const router = (
  chainName: string,
  standard: TokenStandard,
): WarpCoreConfig['tokens'][number] => ({
  chainName,
  standard,
  addressOrDenom: '0x1111111111111111111111111111111111111111',
  decimals: 6,
  symbol: 'USDC',
  name: 'USDC',
});

describe('logXERC20Limits', () => {
  afterEach(() => sinon.restore());

  it('logs an Aevo router with the limits its adapter states, formatted in the units of its token', async () => {
    sinon.stub(EvmHypAevoXERC20Adapter.prototype, 'getLimits').resolves(LIMITS);
    const table = sinon.stub(console, 'table');
    const warpCoreConfig: WarpCoreConfig = {
      tokens: [router('test1', TokenStandard.EvmHypAevoXERC20)],
    };

    await logXERC20Limits(
      warpCoreConfig,
      MultiProvider.createTestMultiProvider(),
    );

    sinon.assert.calledOnceWithExactly(table, {
      test1: { mint: '75.0', burn: '30.0' },
    });
  });

  // The limits are logged for the reader of the output, and the configs that
  // `warp read` derives do not wait on them.
  it('warns of a chain whose limits cannot be read, and logs those of the others', async () => {
    const getLimits = sinon.stub(
      EvmHypAevoXERC20Adapter.prototype,
      'getLimits',
    );
    getLimits.onFirstCall().resolves(LIMITS);
    getLimits.onSecondCall().rejects(new Error('RPC unavailable'));
    const table = sinon.stub(console, 'table');
    const warn = sinon.stub(rootLogger, 'warn');
    const warpCoreConfig: WarpCoreConfig = {
      tokens: [
        router('test1', TokenStandard.EvmHypAevoXERC20),
        router('test2', TokenStandard.EvmHypAevoXERC20),
      ],
    };

    await logXERC20Limits(
      warpCoreConfig,
      MultiProvider.createTestMultiProvider(),
    );

    sinon.assert.calledOnceWithExactly(table, {
      test1: { mint: '75.0', burn: '30.0' },
    });
    sinon.assert.calledOnce(warn);
    expect(String(warn.firstCall.args[0])).to.include('test2');
    expect(String(warn.firstCall.args[0])).to.include('RPC unavailable');
  });

  // A Velodrome router is among the ones whose limits are logged, and its
  // limits are read from the token, which may not answer.
  it('warns of a Velodrome router whose limits cannot be read, and logs those of an Aevo one', async () => {
    sinon.stub(EvmHypAevoXERC20Adapter.prototype, 'getLimits').resolves(LIMITS);
    const multiProvider = MultiProvider.createTestMultiProvider();
    sinon
      .stub(multiProvider.getProvider('test1'), 'call')
      .rejects(new Error('call failed'));
    const table = sinon.stub(console, 'table');
    const warn = sinon.stub(rootLogger, 'warn');

    await logXERC20Limits(
      {
        tokens: [
          router('test1', TokenStandard.EvmHypVSXERC20),
          router('test2', TokenStandard.EvmHypAevoXERC20),
        ],
      },
      multiProvider,
    );

    sinon.assert.calledOnceWithExactly(table, {
      test2: { mint: '75.0', burn: '30.0' },
    });
    sinon.assert.calledOnce(warn);
    expect(String(warn.firstCall.args[0])).to.include('test1');
    expect(String(warn.firstCall.args[0])).to.include('call failed');
  });

  it('logs no table when no chain has limits that can be read', async () => {
    sinon
      .stub(EvmHypAevoXERC20Adapter.prototype, 'getLimits')
      .rejects(new Error('RPC unavailable'));
    const table = sinon.stub(console, 'table');
    const warn = sinon.stub(rootLogger, 'warn');

    await logXERC20Limits(
      { tokens: [router('test1', TokenStandard.EvmHypAevoXERC20)] },
      MultiProvider.createTestMultiProvider(),
    );

    sinon.assert.notCalled(table);
    sinon.assert.calledOnce(warn);
  });
});

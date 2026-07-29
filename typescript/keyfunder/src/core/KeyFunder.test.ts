import { expect } from 'chai';
import { BigNumber } from 'ethers';
import type { Logger } from 'pino';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';
import type { KeyFunderMetrics } from '../metrics/Metrics.js';

import { KeyFunder } from './KeyFunder.js';

describe('KeyFunder', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('scales the funder balance metric by the chain native token decimals', async () => {
    const logger = {
      child: () => logger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;

    const multiProvider = sinon.createStubInstance(MultiProvider);
    // 1152 TRX at 6 decimals = 1_152_000_000 sun.
    multiProvider.getSigner.returns({
      getAddress: async () => '0x2222222222222222222222222222222222222222',
      getBalance: async () => BigNumber.from('1152000000'),
    } as never);
    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'TRON', symbol: 'TRX', decimals: 6 },
    } as never);

    const recordUnifiedWalletBalance = sinon.spy();
    const metrics = {
      recordUnifiedWalletBalance,
    } as unknown as KeyFunderMetrics;

    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: { tron: {} },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger,
      metrics,
    });

    await (
      keyFunder as unknown as {
        recordFunderBalance: (chain: string) => Promise<void>;
      }
    ).recordFunderBalance('tron');

    sinon.assert.calledOnceWithExactly(
      recordUnifiedWalletBalance,
      'tron',
      '0x2222222222222222222222222222222222222222',
      'key-funder',
      1152,
    );
  });

  it('should continue funding when recordFunderBalance fails', async () => {
    const chainWarnSpy = sinon.spy();
    const chainInfoSpy = sinon.spy();

    const chainLogger = {
      child: () => chainLogger,
      debug: () => undefined,
      error: () => undefined,
      info: (...args: unknown[]) => chainInfoSpy(...args),
      warn: (...args: unknown[]) => chainWarnSpy(...args),
    } as unknown as Logger;

    const logger = {
      child: () => chainLogger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;

    const multiProvider = sinon.createStubInstance(MultiProvider);

    const config: KeyFunderConfig = {
      version: '1',
      roles: {
        relayer: { address: '0x1111111111111111111111111111111111111111' },
      },
      chains: {
        ethereum: {
          balances: {
            relayer: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger,
    });
    const recordFunderBalanceStub = sinon.stub(
      keyFunder as unknown as {
        recordFunderBalance: (chain: string) => Promise<void>;
      },
      'recordFunderBalance',
    );
    recordFunderBalanceStub.rejects(new Error('RPC failure'));

    const fundKeysStub = sinon.stub(
      keyFunder as unknown as {
        fundKeys: (chain: string, keys: unknown[]) => Promise<void>;
      },
      'fundKeys',
    );
    fundKeysStub.resolves();

    await keyFunder.fundChain('ethereum');

    sinon.assert.calledOnce(recordFunderBalanceStub);
    sinon.assert.calledOnce(fundKeysStub);
    sinon.assert.calledOnce(chainWarnSpy);
    const warnArgs = chainWarnSpy.firstCall.args;
    expect(warnArgs[1]).to.equal(
      'Failed to record funder balance metric, continuing',
    );
    expect((warnArgs[0] as { error: unknown }).error).to.be.instanceOf(Error);

    sinon.assert.calledOnce(chainInfoSpy);
    const infoArgs = chainInfoSpy.firstCall.args;
    expect(infoArgs[1]).to.equal('Chain funding completed');
    expect(
      (infoArgs[0] as { durationSeconds: unknown }).durationSeconds,
    ).to.be.a('number');
  });
});

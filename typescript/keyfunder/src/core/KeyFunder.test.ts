import { expect } from 'chai';
import type { Logger } from 'pino';
import sinon from 'sinon';

import { MultiProtocolProvider, MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';

import { KeyFunder } from './KeyFunder.js';

describe('KeyFunder', () => {
  afterEach(() => {
    sinon.restore();
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
    const multiProtocolProvider = sinon.createStubInstance(MultiProtocolProvider);

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

    const keyFunder = new KeyFunder(multiProvider, multiProtocolProvider, config, {
      logger,
      getSigner: async () => ({
        address: async () => '0x1111111111111111111111111111111111111111',
        sendAndConfirmTransaction: async () => '0xhash',
      }),
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

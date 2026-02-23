import type { Logger } from 'pino';
import sinon from 'sinon';

import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';

import { KeyFunder } from './KeyFunder.js';

describe('KeyFunder', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should continue funding when recordFunderBalance fails', async () => {
    const chainWarnStub = sinon.stub();
    const chainInfoStub = sinon.stub();

    const chainLogger: Pick<
      Logger,
      'child' | 'debug' | 'error' | 'info' | 'warn'
    > = {
      child: sinon.stub(),
      debug: sinon.stub(),
      error: sinon.stub(),
      info: chainInfoStub,
      warn: chainWarnStub,
    };

    const logger: Pick<Logger, 'child' | 'debug' | 'error' | 'info' | 'warn'> =
      {
        child: sinon.stub().returns(chainLogger as Logger),
        debug: sinon.stub(),
        error: sinon.stub(),
        info: sinon.stub(),
        warn: sinon.stub(),
      };

    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x1234567890123456789012345678901234567890'),
      getBalance: sinon.stub().rejects(new Error('RPC failure')),
    };

    const multiProvider = {
      getSigner: sinon.stub().returns(signer),
    };

    const config: KeyFunderConfig = {
      version: '1',
      roles: {
        relayer: { address: '0x1111111111111111111111111111111111111111' },
      },
      chains: {
        ethereum: {},
      },
    };

    const keyFunder = new KeyFunder(multiProvider as MultiProvider, config, {
      logger: logger as Logger,
    });

    await keyFunder.fundChain('ethereum');

    sinon.assert.calledOnce(multiProvider.getSigner);
    sinon.assert.calledOnce(chainWarnStub);
    sinon.assert.calledWithMatch(
      chainWarnStub,
      { error: sinon.match.instanceOf(Error) },
      'Failed to record funder balance metric, continuing',
    );
    sinon.assert.calledOnce(chainInfoStub);
  });
});

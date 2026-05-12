import { expect } from 'chai';
import { BigNumber, Wallet } from 'ethers';
import type { Logger } from 'pino';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';
import { BridgeType } from '../config/types.js';

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

  it('should bridge to Arbitrum Orbit when child funder balance is below threshold', async () => {
    const logger = {
      child: () => logger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;

    const childFunder = '0x1111111111111111111111111111111111111111';
    const parentSigner = Wallet.createRandom();
    const childProvider = {
      getBalance: sinon.stub().resolves(BigNumber.from(0)),
    } as unknown as ReturnType<MultiProvider['getProvider']>;
    const parentBalance = BigNumber.from(10).pow(18).mul(2);
    sinon.stub(parentSigner, 'getBalance').resolves(parentBalance);

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSignerAddress
      .withArgs('arbitrumorbit')
      .resolves(childFunder);
    multiProvider.getProvider.withArgs('arbitrumorbit').returns(childProvider);
    multiProvider.getSigner.withArgs('ethereum').returns(parentSigner);
    multiProvider.getTransactionOverrides.withArgs('ethereum').returns({});
    multiProvider.handleTx.resolves({
      transactionHash: '0xabc',
    } as Awaited<ReturnType<MultiProvider['handleTx']>>);
    multiProvider.tryGetExplorerTxUrl.returns(null);

    const depositEth = sinon.stub().resolves({ hash: '0xabc' });
    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: {
        arbitrumorbit: {
          bridge: {
            type: BridgeType.ArbitrumOrbit,
            parentChain: 'ethereum',
            inbox: '0x000000000000000000000000000000000000006e',
            threshold: '0.5',
            targetBalance: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger,
      arbitrumOrbitInboxFactory: () => ({ depositEth }),
    });
    const recordFunderBalanceStub = sinon
      .stub(
        keyFunder as unknown as {
          recordFunderBalance: (chain: string) => Promise<void>;
        },
        'recordFunderBalance',
      )
      .resolves();

    await keyFunder.fundChain('arbitrumorbit');

    sinon.assert.calledOnce(depositEth);
    expect(depositEth.firstCall.args[0].value.eq(BigNumber.from(10).pow(18))).to
      .be.true;
    expect(multiProvider.handleTx.calledWith('ethereum')).to.be.true;
    sinon.assert.calledOnce(recordFunderBalanceStub);
  });

  it('should skip Arbitrum Orbit bridge when child balance is sufficient', async () => {
    const logger = {
      child: () => logger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;

    const childFunder = '0x1111111111111111111111111111111111111111';
    const childProvider = {
      getBalance: sinon.stub().resolves(BigNumber.from(10).pow(18)),
    } as unknown as ReturnType<MultiProvider['getProvider']>;

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSignerAddress
      .withArgs('arbitrumorbit')
      .resolves(childFunder);
    multiProvider.getProvider.withArgs('arbitrumorbit').returns(childProvider);

    const depositEth = sinon.stub();
    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: {
        arbitrumorbit: {
          bridge: {
            type: BridgeType.ArbitrumOrbit,
            parentChain: 'ethereum',
            inbox: '0x000000000000000000000000000000000000006e',
            threshold: '0.5',
            targetBalance: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger,
      arbitrumOrbitInboxFactory: () => ({ depositEth }),
    });
    sinon
      .stub(
        keyFunder as unknown as {
          recordFunderBalance: (chain: string) => Promise<void>;
        },
        'recordFunderBalance',
      )
      .resolves();

    await keyFunder.fundChain('arbitrumorbit');

    sinon.assert.notCalled(depositEth);
    expect(multiProvider.handleTx.called).to.be.false;
  });
});

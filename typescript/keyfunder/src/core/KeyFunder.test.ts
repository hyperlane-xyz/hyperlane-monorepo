import { expect } from 'chai';
import { ethers } from 'ethers';
import type { Logger } from 'pino';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import { BridgeType, type KeyFunderConfig } from '../config/types.js';

import { KeyFunder } from './KeyFunder.js';

function makeTestLogger(): Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
  return logger as unknown as Logger;
}

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

  it('should bridge OP Stack child funder when below threshold', async () => {
    const childSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x2222222222222222222222222222222222222222'),
      getBalance: sinon
        .stub()
        .onFirstCall()
        .resolves(ethers.utils.parseEther('0.1'))
        .onSecondCall()
        .resolves(ethers.utils.parseEther('1')),
    };
    const parentSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x3333333333333333333333333333333333333333'),
      getBalance: sinon.stub().resolves(ethers.utils.parseEther('2')),
    };
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSigner.withArgs('optimism').returns(childSigner as never);
    multiProvider.getSigner.withArgs('ethereum').returns(parentSigner as never);
    multiProvider.getSignerAddress
      .withArgs('optimism')
      .resolves('0x2222222222222222222222222222222222222222');
    multiProvider.tryGetExplorerTxUrl.returns('https://explorer/tx/0xabc');

    const bridgeETHTo = sinon.stub().resolves({
      hash: '0xabc',
      wait: sinon.stub().resolves({ transactionHash: '0xabc' }),
    });
    const estimateBridgeETHToFee = sinon
      .stub()
      .resolves(ethers.utils.parseEther('0.01'));
    const opStackStandardBridgeFactory = sinon.stub().returns({
      estimateBridgeETHToFee,
      bridgeETHTo,
    });
    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: {
        optimism: {
          bridge: {
            type: BridgeType.OpStack,
            parentChain: 'ethereum',
            standardBridge: '0x4200000000000000000000000000000000000010',
            threshold: '0.5',
            targetBalance: '1',
            minGasLimit: 150_000,
            extraData: '0x1234',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: makeTestLogger(),
      opStackStandardBridgeFactory,
    });

    await keyFunder.fundChain('optimism');

    sinon.assert.calledOnceWithExactly(
      opStackStandardBridgeFactory,
      '0x4200000000000000000000000000000000000010',
      parentSigner,
    );
    sinon.assert.calledOnceWithExactly(
      estimateBridgeETHToFee,
      '0x2222222222222222222222222222222222222222',
      150_000,
      '0x1234',
      { value: ethers.utils.parseEther('0.9') },
    );
    sinon.assert.calledOnceWithExactly(
      bridgeETHTo,
      '0x2222222222222222222222222222222222222222',
      150_000,
      '0x1234',
      { value: ethers.utils.parseEther('0.9') },
    );
  });

  it('should include estimated bridge fee in parent balance preflight', async () => {
    const childSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x2222222222222222222222222222222222222222'),
      getBalance: sinon.stub().resolves(ethers.utils.parseEther('0.1')),
    };
    const parentSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x3333333333333333333333333333333333333333'),
      getBalance: sinon.stub().resolves(ethers.utils.parseEther('0.9')),
    };
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSigner.withArgs('optimism').returns(childSigner as never);
    multiProvider.getSigner.withArgs('ethereum').returns(parentSigner as never);
    multiProvider.getSignerAddress
      .withArgs('optimism')
      .resolves('0x2222222222222222222222222222222222222222');

    const bridgeETHTo = sinon.stub();
    const opStackStandardBridgeFactory = sinon.stub().returns({
      estimateBridgeETHToFee: sinon
        .stub()
        .resolves(ethers.utils.parseEther('0.01')),
      bridgeETHTo,
    });
    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: {
        optimism: {
          bridge: {
            type: BridgeType.OpStack,
            parentChain: 'ethereum',
            standardBridge: '0x4200000000000000000000000000000000000010',
            threshold: '0.5',
            targetBalance: '1',
            minGasLimit: 150_000,
            extraData: '0x1234',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: makeTestLogger(),
      opStackStandardBridgeFactory,
    });

    let thrown: unknown;
    try {
      await keyFunder.fundChain('optimism');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.include(
      'including estimated bridge fee',
    );
    sinon.assert.notCalled(bridgeETHTo);
  });

  it('should wait for OP Stack bridge relay before funding child keys', async () => {
    const childSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x2222222222222222222222222222222222222222'),
      getBalance: sinon
        .stub()
        .onFirstCall()
        .resolves(ethers.utils.parseEther('0.1'))
        .onSecondCall()
        .resolves(ethers.utils.parseEther('1')),
    };
    const parentSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x3333333333333333333333333333333333333333'),
      getBalance: sinon.stub().resolves(ethers.utils.parseEther('2')),
    };
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSigner.withArgs('optimism').returns(childSigner as never);
    multiProvider.getSigner.withArgs('ethereum').returns(parentSigner as never);
    multiProvider.getSignerAddress
      .withArgs('optimism')
      .resolves('0x2222222222222222222222222222222222222222');
    multiProvider.tryGetExplorerTxUrl.returns('https://explorer/tx/0xabc');

    const bridgeETHTo = sinon.stub().resolves({
      hash: '0xabc',
      wait: sinon.stub().resolves({ transactionHash: '0xabc' }),
    });
    const opStackStandardBridgeFactory = sinon.stub().returns({
      estimateBridgeETHToFee: sinon
        .stub()
        .resolves(ethers.utils.parseEther('0.01')),
      bridgeETHTo,
    });
    const config: KeyFunderConfig = {
      version: '1',
      roles: {
        relayer: { address: '0x1111111111111111111111111111111111111111' },
      },
      chains: {
        optimism: {
          bridge: {
            type: BridgeType.OpStack,
            parentChain: 'ethereum',
            standardBridge: '0x4200000000000000000000000000000000000010',
            threshold: '0.5',
            targetBalance: '1',
            minGasLimit: 150_000,
            extraData: '0x1234',
          },
          balances: {
            relayer: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: makeTestLogger(),
      opStackStandardBridgeFactory,
    });
    const recordFunderBalanceStub = sinon
      .stub(
        keyFunder as unknown as {
          recordFunderBalance: (chain: string) => Promise<void>;
        },
        'recordFunderBalance',
      )
      .callsFake(async () => {
        sinon.assert.calledTwice(childSigner.getBalance);
      });
    const fundKeysStub = sinon
      .stub(
        keyFunder as unknown as {
          fundKeys: (chain: string, keys: unknown[]) => Promise<void>;
        },
        'fundKeys',
      )
      .callsFake(async () => {
        sinon.assert.calledTwice(childSigner.getBalance);
      });

    await keyFunder.fundChain('optimism');

    sinon.assert.calledOnce(bridgeETHTo);
    sinon.assert.calledTwice(childSigner.getBalance);
    sinon.assert.calledOnce(recordFunderBalanceStub);
    sinon.assert.calledOnce(fundKeysStub);
  });

  it('should skip OP Stack bridge when child funder is above threshold', async () => {
    const childSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x2222222222222222222222222222222222222222'),
      getBalance: sinon.stub().resolves(ethers.utils.parseEther('0.6')),
    };
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSigner.withArgs('optimism').returns(childSigner as never);
    multiProvider.getSignerAddress
      .withArgs('optimism')
      .resolves('0x2222222222222222222222222222222222222222');
    const opStackStandardBridgeFactory = sinon.stub();
    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: {
        optimism: {
          bridge: {
            type: BridgeType.OpStack,
            parentChain: 'ethereum',
            standardBridge: '0x4200000000000000000000000000000000000010',
            threshold: '0.5',
            targetBalance: '1',
            minGasLimit: 200_000,
            extraData: '0x',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: makeTestLogger(),
      opStackStandardBridgeFactory,
    });

    await keyFunder.fundChain('optimism');

    sinon.assert.notCalled(opStackStandardBridgeFactory);
  });
});

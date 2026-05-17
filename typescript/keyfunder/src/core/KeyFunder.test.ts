import { expect } from 'chai';
import { BigNumber, Wallet } from 'ethers';
import type { ContractReceipt } from 'ethers';
import type { Logger } from 'pino';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import { BridgeType, type KeyFunderConfig } from '../config/types.js';

import { KeyFunder } from './KeyFunder.js';

const nullLogger = {
  child: () => nullLogger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
} as unknown as Logger;

function createReceipt(transactionHash: string): ContractReceipt {
  return {
    to: '0x0000000000000000000000000000000000000001',
    from: '0x0000000000000000000000000000000000000002',
    contractAddress: '',
    transactionIndex: 0,
    gasUsed: BigNumber.from(0),
    logsBloom: '',
    blockHash: '0xabc',
    transactionHash,
    logs: [],
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: BigNumber.from(0),
    effectiveGasPrice: BigNumber.from(0),
    byzantium: true,
    type: 0,
    events: [],
  };
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

  it('should bridge to an OP Stack chain when child funder balance is below threshold', async () => {
    const childFunder = '0x1111111111111111111111111111111111111111';
    const parentSigner = Wallet.createRandom();
    const childProvider = {
      getBalance: sinon.stub().resolves(BigNumber.from(0)),
    } as unknown as ReturnType<MultiProvider['getProvider']>;
    sinon
      .stub(parentSigner, 'getBalance')
      .resolves(BigNumber.from(10).pow(18).mul(2));

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSignerAddress.withArgs('optimism').resolves(childFunder);
    multiProvider.getProvider.withArgs('optimism').returns(childProvider);
    multiProvider.getSigner.withArgs('ethereum').returns(parentSigner);
    multiProvider.getTransactionOverrides.withArgs('ethereum').returns({});
    multiProvider.handleTx.resolves(createReceipt('0xabc'));
    multiProvider.tryGetExplorerTxUrl.returns(null);

    const bridgeETHTo = sinon.stub().resolves({ hash: '0xabc' });
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
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: nullLogger,
      opStackStandardBridgeFactory: () => ({ bridgeETHTo }),
    });
    sinon
      .stub(
        keyFunder as unknown as {
          recordFunderBalance: (chain: string) => Promise<void>;
        },
        'recordFunderBalance',
      )
      .resolves();

    await keyFunder.fundChain('optimism');

    sinon.assert.calledOnce(bridgeETHTo);
    expect(bridgeETHTo.firstCall.args[0]).to.equal(childFunder);
    expect(bridgeETHTo.firstCall.args[1]).to.equal(200_000);
    expect(bridgeETHTo.firstCall.args[2]).to.equal('0x');
    expect(bridgeETHTo.firstCall.args[3].value.eq(BigNumber.from(10).pow(18)))
      .to.be.true;
    expect(multiProvider.handleTx.calledWith('ethereum')).to.be.true;
  });

  it('should skip OP Stack bridge when child funder balance is sufficient', async () => {
    const childFunder = '0x1111111111111111111111111111111111111111';
    const childProvider = {
      getBalance: sinon.stub().resolves(BigNumber.from(10).pow(18)),
    } as unknown as ReturnType<MultiProvider['getProvider']>;

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSignerAddress.withArgs('optimism').resolves(childFunder);
    multiProvider.getProvider.withArgs('optimism').returns(childProvider);

    const bridgeETHTo = sinon.stub();
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
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: nullLogger,
      opStackStandardBridgeFactory: () => ({ bridgeETHTo }),
    });
    sinon
      .stub(
        keyFunder as unknown as {
          recordFunderBalance: (chain: string) => Promise<void>;
        },
        'recordFunderBalance',
      )
      .resolves();

    await keyFunder.fundChain('optimism');

    sinon.assert.notCalled(bridgeETHTo);
    expect(multiProvider.handleTx.called).to.be.false;
  });
});

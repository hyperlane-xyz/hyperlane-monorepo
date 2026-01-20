import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { formatStandardHookMetadata } from '@hyperlane-xyz/utils';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress } from '../../test/testUtils.js';

import { InterchainAccount } from './InterchainAccount.js';

describe('InterchainAccount.getCallRemote', () => {
  const defaultGasLimit = BigNumber.from(50_000);
  const chain = TestChainName.test1;
  const destination = TestChainName.test2;

  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let app: InterchainAccount;
  let mockLocalRouter: Record<string, any>;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
    sandbox.stub(multiProvider, 'getSigner').returns({} as any);

    const contractsMap = {
      [chain]: { interchainAccountRouter: { address: randomAddress() } },
      [destination]: { interchainAccountRouter: { address: randomAddress() } },
    } as any;
    app = new InterchainAccount(contractsMap, multiProvider);

    mockLocalRouter = {
      ['quoteGasPayment(uint32,uint256)']: sandbox
        .stub()
        .resolves(BigNumber.from(123)),
      ['quoteGasPayment(uint32)']: sandbox.stub().resolves(BigNumber.from(456)),
      populateTransaction: {
        ['callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)']:
          sandbox.stub().resolves({
            to: randomAddress(),
            data: '0x',
            value: BigNumber.from(0),
          }),
      },
    };

    sandbox
      .stub(InterchainAccountRouter__factory, 'connect')
      .returns(mockLocalRouter as any);
  });

  afterEach(() => {
    sandbox.restore();
  });

  const baseConfig = {
    origin: chain,
    owner: randomAddress(),
    localRouter: randomAddress(),
    routerOverride: randomAddress(),
    ismOverride: randomAddress(),
  };

  const baseCalls = [{ to: randomAddress(), data: '0x', value: '0' }];

  it('uses IGP default gas when hookMetadata is missing', async () => {
    await app.getCallRemote({
      chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    sinon.assert.calledOnce(mockLocalRouter['quoteGasPayment(uint32,uint256)']);
    const [, gasLimit] =
      mockLocalRouter['quoteGasPayment(uint32,uint256)'].getCall(0).args;
    expect(gasLimit.toNumber()).to.equal(defaultGasLimit.toNumber());
  });

  it('uses gasLimit from StandardHookMetadata when provided', async () => {
    const gasLimit = 123_456n;
    const hookMetadata = formatStandardHookMetadata({
      refundAddress: randomAddress(),
      gasLimit,
    });

    await app.getCallRemote({
      chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
      hookMetadata,
    });

    const [, gasLimitArg] =
      mockLocalRouter['quoteGasPayment(uint32,uint256)'].getCall(0).args;
    expect(gasLimitArg.toString()).to.equal(
      BigNumber.from(gasLimit).toString(),
    );
  });

  it('falls back to IGP default gas on malformed metadata', async () => {
    await app.getCallRemote({
      chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
      hookMetadata: '0xZZ',
    });

    const [, gasLimit] =
      mockLocalRouter['quoteGasPayment(uint32,uint256)'].getCall(0).args;
    expect(gasLimit.toNumber()).to.equal(defaultGasLimit.toNumber());
  });

  it('falls back to legacy quoteGasPayment overload when needed', async () => {
    mockLocalRouter['quoteGasPayment(uint32,uint256)'].rejects(
      new Error('legacy router'),
    );

    await app.getCallRemote({
      chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    sinon.assert.calledOnce(mockLocalRouter['quoteGasPayment(uint32)']);
  });
});

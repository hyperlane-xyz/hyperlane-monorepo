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

  it('falls back to mailbox quoteDispatch when v2 quote fails', async () => {
    mockLocalRouter['quoteGasPayment(uint32,uint256)'].rejects(
      new Error('legacy router'),
    );

    // Add mailbox stub for legacy fallback path
    const mockMailboxAddress = randomAddress();
    mockLocalRouter.mailbox = sandbox.stub().resolves(mockMailboxAddress);

    // Create a mock provider with proper call responses for mailbox contract
    const defaultHookAddress = randomAddress();
    const mockProvider = {
      _isProvider: true,
      // Respond to defaultHook() call - returns address
      // Respond to quoteDispatch() call - returns uint256
      call: sandbox.stub().callsFake((tx: any) => {
        // defaultHook() selector: 0x...
        if (tx.data?.startsWith('0x3a871cdd')) {
          // Return encoded address
          return Promise.resolve(
            '0x000000000000000000000000' + defaultHookAddress.slice(2),
          );
        }
        // quoteDispatch() - return encoded uint256
        return Promise.resolve(
          '0x0000000000000000000000000000000000000000000000000000000000000315',
        );
      }),
      getNetwork: sandbox.stub().resolves({ chainId: 1, name: 'test' }),
    };
    sandbox.stub(multiProvider, 'getProvider').returns(mockProvider as any);

    await app.getCallRemote({
      chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    // Verify the fallback path was taken
    sinon.assert.calledOnce(mockLocalRouter.mailbox);
  });

  it('calls isms() with origin domain when ismOverride not provided', async () => {
    const destRouterAddress = randomAddress();
    const mockDestRouter = {
      isms: sandbox.stub().resolves(randomAddress()),
    };

    // Restore the factory stub and recreate with address-aware logic
    (InterchainAccountRouter__factory.connect as sinon.SinonStub).restore();
    sandbox
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address === destRouterAddress) {
          return mockDestRouter as any;
        }
        return mockLocalRouter as any;
      });

    const configWithoutIsmOverride = {
      origin: chain,
      owner: randomAddress(),
      localRouter: randomAddress(),
      routerOverride: destRouterAddress,
    };

    await app.getCallRemote({
      chain,
      destination,
      innerCalls: baseCalls,
      config: configWithoutIsmOverride,
    });

    const originDomain = multiProvider.getDomainId(chain);
    sinon.assert.calledWith(mockDestRouter.isms, originDomain);
  });
});

describe('InterchainAccount.estimateIcaHandleGas', () => {
  const chain = TestChainName.test1;
  const destination = TestChainName.test2;
  const ICA_OVERHEAD = BigNumber.from(50_000);
  const PER_CALL_OVERHEAD = BigNumber.from(5_000);
  const PER_CALL_FALLBACK = BigNumber.from(50_000);
  const ICA_HANDLE_GAS_FALLBACK = BigNumber.from(200_000);

  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let app: InterchainAccount;
  let mockDestRouter: Record<string, any>;
  let mockProvider: Record<string, any>;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();

    mockProvider = {
      estimateGas: sandbox.stub(),
    };

    mockDestRouter = {
      address: randomAddress(),
      isms: sandbox.stub().resolves(randomAddress()),
      mailbox: sandbox.stub().resolves(randomAddress()),
      routers: sandbox.stub().resolves(randomAddress()),
      estimateGas: {
        handle: sandbox.stub(),
      },
    };

    const mockOriginRouter = {
      address: randomAddress(),
      connect: sandbox.stub().returnsThis(),
    };

    // Create contractsMap - origin needs connect() for constructor processing
    const contractsMap: Record<string, any> = {};
    contractsMap[chain] = { interchainAccountRouter: mockOriginRouter };
    contractsMap[destination] = { interchainAccountRouter: mockDestRouter };

    // Mock connect() to return self (required by connectContracts)
    mockDestRouter.connect = sandbox.stub().returns(mockDestRouter);

    app = new InterchainAccount(contractsMap as any, multiProvider);

    // Stub getProvider after app creation to avoid affecting constructor
    sandbox.stub(multiProvider, 'getProvider').returns(mockProvider as any);
  });

  afterEach(() => {
    sandbox.restore();
  });

  const baseConfig = {
    origin: chain,
    owner: randomAddress(),
    localRouter: randomAddress(),
  };

  const baseCalls = [
    { to: randomAddress(), data: '0x1234', value: '0' },
    { to: randomAddress(), data: '0x5678', value: '0' },
  ];

  it('returns buffered handle() estimate when it succeeds', async () => {
    const handleEstimate = BigNumber.from(100_000);
    mockDestRouter.estimateGas.handle.resolves(handleEstimate);

    const result = await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    // addBufferToGasLimit adds 10%
    const expectedWithBuffer = handleEstimate.mul(110).div(100);
    expect(result.toString()).to.equal(expectedWithBuffer.toString());
  });

  it('falls back to individual estimation when handle() fails', async () => {
    mockDestRouter.estimateGas.handle.rejects(new Error('handle failed'));

    // Individual call estimates
    const call1Estimate = BigNumber.from(30_000);
    const call2Estimate = BigNumber.from(40_000);
    mockProvider.estimateGas
      .onFirstCall()
      .resolves(call1Estimate)
      .onSecondCall()
      .resolves(call2Estimate);

    const result = await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    // Total = calls + ICA overhead + per-call overhead
    const callsTotal = call1Estimate.add(call2Estimate);
    const overhead = ICA_OVERHEAD.add(PER_CALL_OVERHEAD.mul(2));
    const expectedBeforeBuffer = callsTotal.add(overhead);
    const expectedWithBuffer = expectedBeforeBuffer.mul(110).div(100);

    expect(result.toString()).to.equal(expectedWithBuffer.toString());
  });

  it('uses per-call fallback when individual call estimation fails', async () => {
    mockDestRouter.estimateGas.handle.rejects(new Error('handle failed'));

    // First call succeeds, second fails (uses per-call fallback)
    const call1Estimate = BigNumber.from(30_000);
    mockProvider.estimateGas
      .onFirstCall()
      .resolves(call1Estimate)
      .onSecondCall()
      .rejects(new Error('call failed'));

    const result = await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    // Second call uses 50k fallback
    const callsTotal = call1Estimate.add(PER_CALL_FALLBACK);
    const overhead = ICA_OVERHEAD.add(PER_CALL_OVERHEAD.mul(2));
    const expectedBeforeBuffer = callsTotal.add(overhead);
    const expectedWithBuffer = expectedBeforeBuffer.mul(110).div(100);

    expect(result.toString()).to.equal(expectedWithBuffer.toString());
  });

  it('returns static 200k fallback when getProvider fails', async () => {
    mockDestRouter.estimateGas.handle.rejects(new Error('handle failed'));

    (multiProvider.getProvider as sinon.SinonStub).throws(
      new Error('provider error'),
    );

    const result = await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    expect(result.toString()).to.equal(ICA_HANDLE_GAS_FALLBACK.toString());
  });
});

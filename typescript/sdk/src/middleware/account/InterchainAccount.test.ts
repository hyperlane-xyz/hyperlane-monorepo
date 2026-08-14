import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import sinon from 'sinon';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import {
  addressToBytes32,
  bytes32ToAddress,
  formatStandardHookMetadata,
} from '@hyperlane-xyz/utils';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress } from '../../test/testUtils.js';

import { InterchainAccount } from './InterchainAccount.js';
import { PostCallsSchema, commitmentFromRevealMessage } from './icaCalls.js';

describe('commitmentFromRevealMessage', () => {
  // https://explorer.hyperlane.xyz/message/0xd123b9eb8fc8777adf50963b2ad283f05332c584a1e4002f9e4ad21bdafea069
  const REVEAL_MESSAGE =
    '0x0200000000000000000000000000000000000000000000000000000000000000002cd4f1bbd58a9c7fc481e3b8d319cea8795011b9dde770fa122c2e585fa01f69';
  const COMMITMENT =
    '0x2cd4f1bbd58a9c7fc481e3b8d319cea8795011b9dde770fa122c2e585fa01f69';

  describe('Valid inputs', () => {
    it('should extract commitment from a valid 65-byte message', () => {
      const result = commitmentFromRevealMessage(REVEAL_MESSAGE);
      expect(result).to.equal(COMMITMENT);
    });
  });

  describe('Invalid inputs - should throw', () => {
    it('should throw when message is too short (< 65 bytes)', () => {
      const shortMessage = REVEAL_MESSAGE.slice(0, 2 + 64 * 2);
      expect(() => commitmentFromRevealMessage(shortMessage)).to.throw(
        'Invalid reveal message: expected at least 65 bytes, got 64 bytes',
      );
    });
  });
});

const basePayload = {
  calls: [
    {
      to: '0x' + 'ab'.repeat(20),
      data: '0x',
      value: '0',
    },
  ],
  relayers: ['0x' + 'cd'.repeat(20)],
  salt: '0x' + '00'.repeat(32),
  originDomain: 1,
};

const icaPayload = (overrides: Record<string, any> = {}) => ({
  ...basePayload,
  destinationDomain: 2,
  owner: '0x' + 'aa'.repeat(20),
  ...overrides,
});

const legacyPayload = (overrides: Record<string, any> = {}) => ({
  ...basePayload,
  commitmentDispatchTx: '0x' + 'ef'.repeat(32),
  ...overrides,
});

describe('PostCallsSchema', () => {
  it('accepts new ICA shape with destinationDomain + owner', () => {
    const result = PostCallsSchema.safeParse(icaPayload());
    expect(result.success).to.be.true;
  });

  it('accepts legacy shape with commitmentDispatchTx', () => {
    const result = PostCallsSchema.safeParse(legacyPayload());
    expect(result.success).to.be.true;
  });

  it('rejects payload missing both discriminants', () => {
    const result = PostCallsSchema.safeParse(basePayload);
    expect(result.success).to.be.false;
  });

  it('accepts valid bytes32 address', () => {
    const result = PostCallsSchema.safeParse(
      icaPayload({
        calls: [{ to: '0x' + 'ab'.repeat(32), data: '0x', value: '0' }],
      }),
    );
    expect(result.success).to.be.true;
  });

  it('rejects empty string to address', () => {
    const result = PostCallsSchema.safeParse(
      icaPayload({
        calls: [{ to: '', data: '0x', value: '0' }],
      }),
    );
    expect(result.success).to.be.false;
  });

  it('rejects URL as to address', () => {
    const result = PostCallsSchema.safeParse(
      icaPayload({
        calls: [{ to: 'http://evil.com', data: '0x', value: '0' }],
      }),
    );
    expect(result.success).to.be.false;
  });

  it('rejects SQL injection in to address', () => {
    const result = PostCallsSchema.safeParse(
      icaPayload({
        calls: [{ to: "'; DROP TABLE--", data: '0x', value: '0' }],
      }),
    );
    expect(result.success).to.be.false;
  });

  it('rejects prototype pollution in to address', () => {
    const result = PostCallsSchema.safeParse(
      icaPayload({
        calls: [{ to: '__proto__', data: '0x', value: '0' }],
      }),
    );
    expect(result.success).to.be.false;
  });

  it('rejects invalid relayer address', () => {
    const result = PostCallsSchema.safeParse(
      icaPayload({ relayers: ['not-an-address'] }),
    );
    expect(result.success).to.be.false;
  });
});

describe('InterchainAccount.getAccount', () => {
  const origin = TestChainName.test1;
  const destination = TestChainName.test2;
  const originDomain = 1;
  const owner = '0x' + '11'.repeat(20);
  const originRouterAddress = '0x' + '22'.repeat(20);
  const destinationRouterAddress = '0x' + '33'.repeat(20);
  const ismAddress = '0x' + '44'.repeat(20);
  const bytecodeHash = '0x' + '55'.repeat(32);

  afterEach(() => sinon.restore());

  function expectedAccount({
    accountOwner = owner,
    router = addressToBytes32(originRouterAddress),
    ism = addressToBytes32(ismAddress),
    salt = InterchainAccount.EMPTY_SALT,
    domain = originDomain,
  }: {
    accountOwner?: string;
    router?: string;
    ism?: string;
    salt?: string;
    domain?: number;
  } = {}) {
    const deploySalt = utils.solidityKeccak256(
      ['uint32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        domain,
        addressToBytes32(accountOwner),
        addressToBytes32(bytes32ToAddress(router)),
        utils.hexZeroPad(bytes32ToAddress(addressToBytes32(ism)), 32),
        salt,
      ],
    );
    return utils.getCreate2Address(
      destinationRouterAddress,
      deploySalt,
      bytecodeHash,
    );
  }

  function createApp({
    router = addressToBytes32(originRouterAddress),
    ism = addressToBytes32(ismAddress),
    hash = bytecodeHash,
    configuredDestination = true,
    domain = originDomain,
  }: {
    router?: string;
    ism?: string;
    hash?: string | Error;
    configuredDestination?: boolean;
    domain?: number | null;
  } = {}) {
    const destinationRouter = {
      address: destinationRouterAddress,
      routers: sinon.stub().resolves(router),
      isms: sinon.stub().resolves(ism),
      bytecodeHash:
        hash instanceof Error
          ? sinon.stub().rejects(hash)
          : sinon.stub().resolves(hash),
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)': sinon
        .stub()
        .resolves(expectedAccount()),
      'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)':
        sinon.stub().resolves({ hash: '0x1234' }),
      estimateGas: {
        'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)':
          sinon.stub().resolves(BigNumber.from(100_000)),
      },
    };
    const provider = {
      getCode: sinon.stub().resolves('0x'),
    };
    const multiProvider = {
      getProvider: sinon.stub().returns(provider),
      getTransactionOverrides: sinon.stub().returns({}),
      handleTx: sinon.stub().resolves(),
      tryGetDomainId: sinon.stub().returns(domain),
    };
    const app = Object.assign(Object.create(InterchainAccount.prototype), {
      contractsMap: configuredDestination
        ? { [destination]: { interchainAccountRouter: destinationRouter } }
        : { [destination]: {} },
      knownAccounts: {},
      logger: { debug: sinon.stub() },
      multiProvider,
    });
    return { app, destinationRouter, multiProvider };
  }

  it('matches a deployed router golden vector', async () => {
    const baseRouter = '0x44647Cd983E80558793780f9a0c7C2aa9F384D07';
    const ethereumRouter = '0xC00b94c115742f711a6F9EA90373c33e9B72A4A9';
    const baseBytecodeHash = [
      '0x539ad958a6ba3e4d7d060e7c4eb03f58',
      '331e502aa3dcc578f34506ddac8b37e9',
    ].join('');
    const { app } = createApp({
      router: addressToBytes32(ethereumRouter),
      ism: constants.HashZero,
      hash: baseBytecodeHash,
    });
    app.contractsMap[destination].interchainAccountRouter.address = baseRouter;

    expect(await app.getAccount(destination, { origin, owner })).to.equal(
      '0xa35B6C3E1604A6da3da2fb1210053Ba876d09CE7',
    );
  });

  it('starts independent metadata reads concurrently', async () => {
    const { app, destinationRouter } = createApp();
    const pending: Array<{
      promise: Promise<string>;
      resolve(value: string): void;
    }> = [];
    for (const method of ['routers', 'isms', 'bytecodeHash'] as const) {
      let resolve!: (value: string) => void;
      const promise = new Promise<string>((complete) => {
        resolve = complete;
      });
      pending.push({ promise, resolve });
      destinationRouter[method].returns(promise);
    }

    const account = app.getAccount(destination, { origin, owner });

    expect(destinationRouter.routers.calledOnce).to.be.true;
    expect(destinationRouter.isms.calledOnce).to.be.true;
    expect(destinationRouter.bytecodeHash.calledOnce).to.be.true;
    pending[0].resolve(addressToBytes32(originRouterAddress));
    pending[1].resolve(addressToBytes32(ismAddress));
    pending[2].resolve(bytecodeHash);
    expect(await account).to.equal(expectedAccount());
  });

  it('uses routing overrides without redundant reads', async () => {
    const { app, destinationRouter } = createApp();

    expect(
      await app.getAccount(destination, {
        origin,
        owner,
        localRouter: originRouterAddress,
        ismOverride: ismAddress,
      }),
    ).to.equal(expectedAccount());
    expect(destinationRouter.routers.called).to.be.false;
    expect(destinationRouter.isms.called).to.be.false;
  });

  it('preserves custom salts and bytes32 normalization', async () => {
    const accountOwner = '0x' + '66'.repeat(32);
    const router = `0x${'77'.repeat(12)}${'88'.repeat(20)}`;
    const ism = `0x${'99'.repeat(12)}${'aa'.repeat(20)}`;
    const salt = '0x' + 'bb'.repeat(32);
    const { app } = createApp({ router, ism });

    expect(
      await app.getAccount(destination, {
        origin,
        owner: accountOwner,
        userSalt: salt,
      }),
    ).to.equal(expectedAccount({ accountOwner, router, ism, salt }));
  });

  it('accepts domain zero and rejects missing domain metadata', async () => {
    const domainZero = createApp({ domain: 0 });
    expect(
      await domainZero.app.getAccount(destination, { origin, owner }),
    ).to.equal(expectedAccount({ domain: 0 }));

    const missingDomain = createApp({ domain: null });
    let caught: unknown;
    try {
      await missingDomain.app.getAccount(destination, { origin, owner });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
  });

  it('falls back only when bytecodeHash is unavailable', async () => {
    const missingSelector = Object.assign(new Error('missing selector'), {
      code: 'CALL_EXCEPTION',
      data: '0x',
    });
    const fallback = createApp({ hash: missingSelector });

    expect(
      await fallback.app.getAccount(destination, { origin, owner }),
    ).to.equal(expectedAccount());
    expect(
      fallback.destinationRouter[
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ].calledOnce,
    ).to.be.true;

    const rpcError = new Error('RPC unavailable');
    const failed = createApp({ hash: rpcError });
    let caught: unknown;
    try {
      await failed.app.getAccount(destination, { origin, owner });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.equal(rpcError);
  });

  it('still deploys a locally derived account when requested', async () => {
    const { app, destinationRouter, multiProvider } = createApp();
    const config = { origin, owner };
    const account = expectedAccount();

    expect(await app.deployAccount(destination, config)).to.equal(account);
    expect(
      destinationRouter.estimateGas[
        'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ].calledOnce,
    ).to.be.true;
    expect(
      destinationRouter[
        'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ].calledOnce,
    ).to.be.true;
    expect(multiProvider.handleTx.calledOnce).to.be.true;
    expect(app.knownAccounts[account]).to.deep.equal(config);
  });

  it('rejects a destination without an ICA router', async () => {
    const { app } = createApp({ configuredDestination: false });
    let caught: unknown;
    try {
      await app.getAccount(destination, { origin, owner });
    } catch (error: unknown) {
      caught = error;
    }
    if (!(caught instanceof Error))
      throw new Error('Expected derivation error');
    expect(caught.message).to.include(
      `No interchain account router configured for ${destination}`,
    );
  });

  it('rejects a zero origin router', async () => {
    const { app } = createApp({ router: constants.HashZero });
    let caught: unknown;
    try {
      await app.getAccount(destination, { origin, owner });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
  });
});

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
  let destinationAccount: string;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();

    mockProvider = {
      estimateGas: sandbox.stub(),
    };
    destinationAccount = randomAddress();

    mockDestRouter = {
      address: randomAddress(),
      isms: sandbox.stub().resolves(randomAddress()),
      mailbox: sandbox.stub().resolves(randomAddress()),
      routers: sandbox.stub().resolves(randomAddress()),
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)':
        sandbox.stub().resolves(destinationAccount),
      'getLocalInterchainAccount(uint32,address,address,address)': sandbox
        .stub()
        .resolves(destinationAccount),
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
    expect(mockProvider.estimateGas.firstCall.args[0].from).to.equal(
      destinationAccount,
    );
    expect(mockProvider.estimateGas.secondCall.args[0].from).to.equal(
      destinationAccount,
    );
  });

  it('falls back to legacy ICA account lookup for individual estimation', async () => {
    mockDestRouter[
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
    ].rejects(new Error('missing overload'));
    mockDestRouter.estimateGas.handle.rejects(new Error('handle failed'));
    mockProvider.estimateGas.resolves(BigNumber.from(30_000));

    const result = await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: [baseCalls[0]],
      config: baseConfig,
    });

    const expectedBeforeBuffer = BigNumber.from(30_000)
      .add(ICA_OVERHEAD)
      .add(PER_CALL_OVERHEAD);
    const expectedWithBuffer = expectedBeforeBuffer.mul(110).div(100);

    expect(result.toString()).to.equal(expectedWithBuffer.toString());
    sinon.assert.calledOnce(
      mockDestRouter[
        'getLocalInterchainAccount(uint32,address,address,address)'
      ],
    );
    expect(mockProvider.estimateGas.firstCall.args[0].from).to.equal(
      destinationAccount,
    );
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

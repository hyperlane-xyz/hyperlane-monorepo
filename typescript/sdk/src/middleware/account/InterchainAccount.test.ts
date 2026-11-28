import { expect } from 'chai';
import {
  BigNumber,
  Contract,
  VoidSigner,
  constants,
  providers,
  utils,
} from 'ethers';
import sinon from 'sinon';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import {
  ProtocolType,
  addressToBytes32,
  assert,
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
    protocol = ProtocolType.Ethereum,
  }: {
    router?: string;
    ism?: string;
    hash?: string | Error;
    configuredDestination?: boolean;
    domain?: number | null;
    protocol?: ProtocolType;
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
      'getLocalInterchainAccount(uint32,address,address,address)': sinon
        .stub()
        .resolves(expectedAccount()),
      'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)':
        sinon.stub().resolves({ hash: '0x1234' }),
      'getDeployedInterchainAccount(uint32,address,address,address)': sinon
        .stub()
        .resolves({ hash: '0x1234' }),
      estimateGas: {
        'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)':
          sinon.stub().resolves(BigNumber.from(100_000)),
        'getDeployedInterchainAccount(uint32,address,address,address)': sinon
          .stub()
          .resolves(BigNumber.from(100_000)),
      },
    };
    const provider = {
      getCode: sinon.stub().resolves('0x'),
    };
    const multiProvider = {
      getProvider: sinon.stub().returns(provider),
      getSignerOrProvider: sinon.stub().returns(provider),
      getTransactionOverrides: sinon.stub().returns({}),
      handleTx: sinon.stub().resolves(),
      getProtocol: sinon.stub().returns(protocol),
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
    return { app, destinationRouter, multiProvider, provider };
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

  it('uses the Tron router getter instead of EVM CREATE2 derivation', async () => {
    const tronAccount = '0x2839B41900b59dEBb43E7d70630BF92d10b86D21';
    const { app, destinationRouter, multiProvider, provider } = createApp({
      router: addressToBytes32('0xC00b94c115742f711a6F9EA90373c33e9B72A4A9'),
      ism: constants.HashZero,
      protocol: ProtocolType.Tron,
    });
    destinationRouter.address = '0x68Cf65eFE8EccFBE30ab0Ca0ecB043C81E395Fc5';
    destinationRouter[
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
    ].resolves(tronAccount);
    provider.getCode.resolves('0x01');

    expect(
      await app.deployAccount(destination, {
        origin,
        owner: '0x562Dfaac27A84be6C96273F5c9594DA1681C0DA7',
      }),
    ).to.equal(tronAccount);
    expect(destinationRouter.bytecodeHash.called).to.be.false;
    sinon.assert.calledOnceWithExactly(provider.getCode, tronAccount);
    expect(multiProvider.handleTx.called).to.be.false;
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

  it('derives V2 and V3 accounts in parallel using the selected destination router', async () => {
    const { app, destinationRouter } = createApp();
    const v3Address = '0x' + '66'.repeat(20);
    const v3Origin = '0x' + '77'.repeat(20);
    const v3Hash = '0x' + '88'.repeat(32);
    const v3Provider = new providers.JsonRpcProvider();
    const signer = new VoidSigner(owner, v3Provider);
    app.multiProvider.getSignerOrProvider.returns(signer);
    const v3Router = InterchainAccountRouter__factory.connect(
      v3Address,
      v3Provider,
    );
    const call = sinon.stub(v3Provider, 'call');
    call.callsFake(async (tx) => {
      const data = await tx.data;
      if (data === v3Router.interface.encodeFunctionData('bytecodeHash')) {
        return utils.defaultAbiCoder.encode(['bytes32'], [v3Hash]);
      }
      if (
        data === v3Router.interface.encodeFunctionData('isms', [originDomain])
      ) {
        return utils.defaultAbiCoder.encode(['bytes32'], [constants.HashZero]);
      }
      throw new Error(`Unexpected V3 router call: ${data}`);
    });
    const connect = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .returns(v3Router);
    const userSalt = '0x' + '99'.repeat(32);
    const v3Salt = utils.solidityKeccak256(
      ['uint32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        originDomain,
        addressToBytes32(owner),
        addressToBytes32(v3Origin),
        constants.HashZero,
        userSalt,
      ],
    );

    expect(await app.getAccount(destination, { origin, owner })).to.equal(
      expectedAccount(),
    );
    expect(
      await app.getAccount(destination, {
        origin,
        owner,
        localRouter: addressToBytes32(v3Origin),
        routerOverride: addressToBytes32(v3Address),
        userSalt,
      }),
    ).to.equal(utils.getCreate2Address(v3Address, v3Salt, v3Hash));
    sinon.assert.calledOnceWithExactly(connect, v3Address, signer);
    sinon.assert.calledOnce(destinationRouter.bytecodeHash);
    sinon.assert.calledTwice(call);
    expect(await app.getAccount(destination, { origin, owner })).to.equal(
      expectedAccount(),
    );
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

  for (const userSalt of [undefined, InterchainAccount.EMPTY_SALT]) {
    it(`supports pre-salt router lookup and deployment with salt ${userSalt}`, async () => {
      const missingSelector = Object.assign(new Error('missing selector'), {
        code: 'CALL_EXCEPTION',
        data: '0x',
      });
      const { app, destinationRouter, multiProvider } = createApp({
        hash: missingSelector,
      });
      destinationRouter[
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ].rejects(missingSelector);
      const config = { origin, owner, userSalt };

      expect(await app.deployAccount(destination, config)).to.equal(
        expectedAccount(),
      );
      sinon.assert.calledOnceWithExactly(
        destinationRouter[
          'getLocalInterchainAccount(uint32,address,address,address)'
        ],
        originDomain,
        owner,
        originRouterAddress,
        ismAddress,
      );
      sinon.assert.calledOnce(
        destinationRouter.estimateGas[
          'getDeployedInterchainAccount(uint32,address,address,address)'
        ],
      );
      sinon.assert.calledOnce(
        destinationRouter[
          'getDeployedInterchainAccount(uint32,address,address,address)'
        ],
      );
      sinon.assert.notCalled(
        destinationRouter.estimateGas[
          'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
        ],
      );
      sinon.assert.calledOnce(multiProvider.handleTx);
    });
  }

  it('does not discard custom salts or mask lookup failures on pre-salt routers', async () => {
    const missingSelector = Object.assign(new Error('missing selector'), {
      code: 'CALL_EXCEPTION',
      data: '0x',
    });
    const rpcError = Object.assign(new Error('RPC unavailable'), {
      code: 'CALL_EXCEPTION',
      data: '0x',
      error: { code: -32000, message: 'header not found' },
    });
    const revert = Object.assign(new Error('lookup reverted'), {
      code: 'CALL_EXCEPTION',
      data: '0x12345678',
    });
    for (const [error, userSalt] of [
      [missingSelector, '0x' + 'ab'.repeat(32)],
      [rpcError, undefined],
      [revert, undefined],
    ] as const) {
      const { app, destinationRouter } = createApp({ hash: missingSelector });
      destinationRouter[
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ].rejects(error);
      const caught = await app
        .getAccount(destination, { origin, owner, userSalt })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(caught).to.equal(error);
      sinon.assert.notCalled(
        destinationRouter[
          'getLocalInterchainAccount(uint32,address,address,address)'
        ],
      );
    }
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

// Body vectors generated with `cast abi-encode` / `cast concat-hex` for
// FIXED_OWNER, FIXED_ISM and FIXED_CALL.
const FIXED_OWNER = '0x' + '11'.repeat(20);
const FIXED_ISM = '0x' + '44'.repeat(20);
const FIXED_SALT = '0x' + '55'.repeat(32);
const FIXED_CALL = { to: '0x' + '22'.repeat(20), data: '0x1234', value: '0' };
const RPC_URL_WITH_KEY = 'https://rpc.example.com/secret-key';
const REDACTED_RPC_ERROR_MESSAGE =
  'missing response (url="<redacted-url>", code=SERVER_ERROR)';

function createRpcError(): Error {
  return Object.assign(
    new Error(
      `missing response (url="${RPC_URL_WITH_KEY}", code=SERVER_ERROR)`,
    ),
    { url: RPC_URL_WITH_KEY },
  );
}
const LEGACY_BODY =
  '0x0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000';
const PACKED_EMPTY_SALT_BODY =
  '0x0000000000000000000000000011111111111111111111111111111111111111110000000000000000000000004444444444444444444444444444444444444444000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000';
const PACKED_FIXED_SALT_BODY =
  '0x0000000000000000000000000011111111111111111111111111111111111111110000000000000000000000004444444444444444444444444444444444444444555555555555555555555555555555555555555555555555555555555555555500000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000';

function missingSelectorError(): Error {
  return Object.assign(new Error('missing selector'), {
    code: 'CALL_EXCEPTION',
    data: '0x',
  });
}

describe('InterchainAccount.getCallRemote', () => {
  const defaultGasLimit = BigNumber.from(50_000);
  const chain = TestChainName.test1;
  const destination = TestChainName.test2;

  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let app: InterchainAccount;
  let mockLocalRouter: Record<string, any>;
  let connectRouter: sinon.SinonStub<
    Parameters<typeof InterchainAccountRouter__factory.connect>,
    ReturnType<typeof InterchainAccountRouter__factory.connect>
  >;

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
      bytecodeHash: sandbox.stub().resolves('0x' + '66'.repeat(32)),
      populateTransaction: {
        ['callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)']:
          sandbox.stub().resolves({
            to: randomAddress(),
            data: '0x',
            value: BigNumber.from(0),
          }),
        ['callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes,bytes32)']:
          sandbox.stub().resolves({
            to: randomAddress(),
            data: '0x',
            value: BigNumber.from(0),
          }),
      },
    };

    connectRouter = sandbox
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

  it('normalizes bytes32 source and destination router overrides', async () => {
    await app.getCallRemote({
      chain,
      destination,
      innerCalls: baseCalls,
      config: {
        ...baseConfig,
        localRouter: addressToBytes32(baseConfig.localRouter),
        routerOverride: addressToBytes32(baseConfig.routerOverride),
      },
    });

    sinon.assert.calledWith(
      connectRouter,
      bytes32ToAddress(baseConfig.localRouter),
    );
    sinon.assert.calledWith(
      connectRouter,
      bytes32ToAddress(baseConfig.routerOverride),
    );
  });

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

  const mailboxInterface = new utils.Interface([
    'function quoteDispatch(uint32,bytes32,bytes,bytes,address) view returns (uint256)',
    'function defaultHook() view returns (address)',
  ]);

  function stubMailboxQuote(): string[] {
    mockLocalRouter.mailbox = sandbox.stub().resolves(randomAddress());
    const provider = new providers.JsonRpcProvider();
    sandbox.stub(multiProvider, 'getProvider').returns(provider);
    const quoteDispatchCalls: string[] = [];
    sandbox.stub(provider, 'call').callsFake(async (tx) => {
      const data = await tx.data;
      assert(typeof data === 'string', 'Expected call data');
      if (data === mailboxInterface.encodeFunctionData('defaultHook')) {
        return utils.defaultAbiCoder.encode(['address'], [randomAddress()]);
      }
      if (data.startsWith(mailboxInterface.getSighash('quoteDispatch'))) {
        quoteDispatchCalls.push(data);
        return utils.defaultAbiCoder.encode(['uint256'], [789]);
      }
      throw new Error(`Unexpected mailbox call: ${data}`);
    });
    return quoteDispatchCalls;
  }

  interface QuoteBodyCase {
    name: string;
    quoteError: () => Error;
    bytecodeHashMissing: boolean;
    userSalt?: string;
    expectedBody: string;
    dispatchOverload: string;
  }

  const unsaltedDispatch =
    'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)';
  const saltedDispatch =
    'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes,bytes32)';

  const quoteBodyCases: QuoteBodyCase[] = [
    {
      name: 'quotes the legacy body when the origin router predates 8.0.0',
      quoteError: missingSelectorError,
      bytecodeHashMissing: true,
      expectedBody: LEGACY_BODY,
      dispatchOverload: unsaltedDispatch,
    },
    {
      name: 'quotes the packed body when the v2 quote fails for another reason',
      quoteError: () => new Error('quote failed'),
      bytecodeHashMissing: false,
      expectedBody: PACKED_EMPTY_SALT_BODY,
      dispatchOverload: unsaltedDispatch,
    },
    {
      name: 'quotes the packed body with the configured user salt',
      quoteError: () => new Error('quote failed'),
      bytecodeHashMissing: false,
      userSalt: FIXED_SALT,
      expectedBody: PACKED_FIXED_SALT_BODY,
      dispatchOverload: saltedDispatch,
    },
    {
      // A downstream hook reverting with empty data looks like a missing
      // selector; the 8.0.0+ router must still be quoted with the packed body.
      name: 'quotes the packed body with a user salt when a hook reverts the v2 quote with empty data',
      quoteError: missingSelectorError,
      bytecodeHashMissing: false,
      userSalt: FIXED_SALT,
      expectedBody: PACKED_FIXED_SALT_BODY,
      dispatchOverload: saltedDispatch,
    },
  ];

  for (const c of quoteBodyCases) {
    it(c.name, async () => {
      mockLocalRouter['quoteGasPayment(uint32,uint256)'].rejects(
        c.quoteError(),
      );
      if (c.bytecodeHashMissing) {
        mockLocalRouter.bytecodeHash.rejects(missingSelectorError());
      }
      const quoteDispatchCalls = stubMailboxQuote();

      await app.getCallRemote({
        chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: {
          origin: chain,
          owner: FIXED_OWNER,
          localRouter: randomAddress(),
          routerOverride: randomAddress(),
          ismOverride: FIXED_ISM,
          userSalt: c.userSalt,
        },
      });

      expect(quoteDispatchCalls).to.have.length(1);
      const [, , body] = mailboxInterface.decodeFunctionData(
        'quoteDispatch',
        quoteDispatchCalls[0],
      );
      expect(body).to.equal(c.expectedBody);
      const dispatch = mockLocalRouter.populateTransaction[c.dispatchOverload];
      sinon.assert.calledOnce(dispatch);
      const dispatchArgs: unknown[] = dispatch.firstCall.args;
      expect(dispatchArgs[dispatchArgs.length - 1]).to.deep.equal({
        value: BigNumber.from(789),
      });
    });
  }

  it('rethrows non-selector bytecodeHash failures on the origin router', async () => {
    const rpcError = Object.assign(new Error('RPC unavailable'), {
      code: 'CALL_EXCEPTION',
      data: '0x',
      error: { code: -32000, message: 'header not found' },
    });
    mockLocalRouter['quoteGasPayment(uint32,uint256)'].rejects(
      new Error('quote failed'),
    );
    mockLocalRouter.bytecodeHash.rejects(rpcError);
    const quoteDispatchCalls = stubMailboxQuote();

    const caught = await app
      .getCallRemote({
        chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: baseConfig,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(caught).to.equal(rpcError);
    expect(quoteDispatchCalls).to.have.length(0);
  });

  it('rejects a user salt when the origin router predates 8.0.0', async () => {
    mockLocalRouter['quoteGasPayment(uint32,uint256)'].rejects(
      missingSelectorError(),
    );
    mockLocalRouter.bytecodeHash.rejects(missingSelectorError());
    const quoteDispatchCalls = stubMailboxQuote();

    const caught = await app
      .getCallRemote({
        chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: {
          origin: chain,
          owner: FIXED_OWNER,
          localRouter: randomAddress(),
          routerOverride: randomAddress(),
          ismOverride: FIXED_ISM,
          userSalt: FIXED_SALT,
        },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    assert(caught instanceof Error, 'Expected getCallRemote to reject');
    expect(caught.message).to.equal(
      `User salts are not supported by the pre-8.0.0 ICA router on ${chain}`,
    );
    expect(quoteDispatchCalls).to.have.length(0);
  });

  interface DispatchSelectorCase {
    name: string;
    userSalt?: string;
    expectedSelector: string;
    expectedSalt?: string;
  }

  // Selectors from `cast sig`.
  const dispatchSelectorCases: DispatchSelectorCase[] = [
    {
      name: 'dispatches via the 5-arg overload when no user salt is set',
      expectedSelector: '0xeab4eaa4',
    },
    {
      name: 'dispatches via the 5-arg overload for an explicit empty salt',
      userSalt: InterchainAccount.EMPTY_SALT,
      expectedSelector: '0xeab4eaa4',
    },
    {
      name: 'dispatches via the salted 6-arg overload for a user salt',
      userSalt: FIXED_SALT,
      expectedSelector: '0x056294d1',
      expectedSalt: FIXED_SALT,
    },
  ];

  for (const c of dispatchSelectorCases) {
    it(c.name, async () => {
      const realRouter = new Contract(
        randomAddress(),
        InterchainAccountRouter__factory.abi,
        new providers.JsonRpcProvider(),
      );
      mockLocalRouter.populateTransaction = realRouter.populateTransaction;

      const tx = await app.getCallRemote({
        chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: {
          origin: chain,
          owner: FIXED_OWNER,
          localRouter: randomAddress(),
          routerOverride: randomAddress(),
          ismOverride: FIXED_ISM,
          userSalt: c.userSalt,
        },
      });

      assert(tx.data, 'Expected dispatch calldata');
      expect(tx.data.slice(0, 10)).to.equal(c.expectedSelector);
      expect(tx.value?.toString()).to.equal('123');
      const decoded = realRouter.interface.decodeFunctionData(
        c.expectedSelector,
        tx.data,
      );
      expect(decoded._ism).to.equal(addressToBytes32(FIXED_ISM));
      expect(decoded._userSalt).to.equal(c.expectedSalt);
    });
  }

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
        if (address.toLowerCase() === destRouterAddress.toLowerCase()) {
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
      getCode: sandbox.stub().resolves('0x6080'),
    };
    destinationAccount = randomAddress();

    mockDestRouter = {
      address: randomAddress(),
      isms: sandbox.stub().resolves(randomAddress()),
      mailbox: sandbox.stub().resolves(randomAddress()),
      routers: sandbox.stub().resolves(randomAddress()),
      bytecodeHash: sandbox.stub().resolves('0x' + '66'.repeat(32)),
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)':
        sandbox.stub().resolves(destinationAccount),
      'getLocalInterchainAccount(uint32,address,address,address)': sandbox
        .stub()
        .resolves(destinationAccount),
      estimateGas: {
        handle: sandbox.stub(),
        'getDeployedInterchainAccount(uint32,address,address,address)':
          sandbox.stub(),
        'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)':
          sandbox.stub(),
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

  it('simulates handle() on a provider-connected router without a router override', async () => {
    mockDestRouter.estimateGas.handle.resolves(BigNumber.from(100_000));

    await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    sinon.assert.calledWith(mockDestRouter.connect, mockProvider);
  });

  it('normalizes a bytes32 destination router override for handle estimation', async () => {
    const router = app.getContracts(destination).interchainAccountRouter;
    const connect = sandbox
      .stub(InterchainAccountRouter__factory, 'connect')
      .returns(router);
    mockDestRouter.estimateGas.handle.resolves(BigNumber.from(100_000));

    await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: baseCalls,
      config: {
        ...baseConfig,
        routerOverride: addressToBytes32(router.address),
      },
    });

    sinon.assert.calledOnce(connect);
    expect(connect.firstCall.args).to.deep.equal([
      bytes32ToAddress(router.address),
      mockProvider,
    ]);
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
    ].rejects(
      Object.assign(new Error('missing overload'), {
        code: 'CALL_EXCEPTION',
        data: '0x',
      }),
    );
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

    (multiProvider.getProvider as sinon.SinonStub).throws(createRpcError());
    const warn = sandbox.spy(app.logger, 'warn');

    const result = await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: baseCalls,
      config: baseConfig,
    });

    expect(result.toString()).to.equal(ICA_HANDLE_GAS_FALLBACK.toString());
    const warnCall = warn
      .getCalls()
      .find(
        (call) =>
          call.args[1] ===
          'Individual call estimation also failed, using static fallback',
      );
    assert(warnCall, 'Expected the static fallback warning');
    expect(warnCall.args[0]).to.deep.equal({
      destination,
      error: REDACTED_RPC_ERROR_MESSAGE,
    });
  });

  const fixedLocalRouter = '0x' + '77'.repeat(20);
  const legacyDeploy =
    'getDeployedInterchainAccount(uint32,address,address,address)';
  const saltedDeploy =
    'getDeployedInterchainAccount(uint32,bytes32,bytes32,address,bytes32)';

  function configureRouter({
    saltedLookupMissing,
    bytecodeHashMissing,
  }: {
    saltedLookupMissing: boolean;
    bytecodeHashMissing: boolean;
  }) {
    if (saltedLookupMissing) {
      mockDestRouter[
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ].rejects(missingSelectorError());
    }
    if (bytecodeHashMissing) {
      mockDestRouter.bytecodeHash.rejects(missingSelectorError());
    }
  }

  interface BodyFormatCase {
    name: string;
    saltedLookupMissing: boolean;
    bytecodeHashMissing: boolean;
    userSalt?: string;
    expectedBody: string;
  }

  const bodyFormatCases: BodyFormatCase[] = [
    {
      name: 'encodes the packed body with an empty salt by default',
      saltedLookupMissing: false,
      bytecodeHashMissing: false,
      expectedBody: PACKED_EMPTY_SALT_BODY,
    },
    {
      name: 'encodes the packed body with the configured user salt',
      saltedLookupMissing: false,
      bytecodeHashMissing: false,
      userSalt: FIXED_SALT,
      expectedBody: PACKED_FIXED_SALT_BODY,
    },
    {
      name: 'encodes the packed body for routers without the salted lookup that expose bytecodeHash',
      saltedLookupMissing: true,
      bytecodeHashMissing: false,
      expectedBody: PACKED_EMPTY_SALT_BODY,
    },
    {
      name: 'encodes the legacy body for pre-8.0.0 routers',
      saltedLookupMissing: true,
      bytecodeHashMissing: true,
      expectedBody: LEGACY_BODY,
    },
  ];

  for (const c of bodyFormatCases) {
    it(c.name, async () => {
      configureRouter({
        saltedLookupMissing: c.saltedLookupMissing,
        bytecodeHashMissing: c.bytecodeHashMissing,
      });
      mockDestRouter.estimateGas.handle.resolves(BigNumber.from(100_000));

      const result = await app.estimateIcaHandleGas({
        origin: chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: {
          origin: chain,
          owner: FIXED_OWNER,
          localRouter: fixedLocalRouter,
          ismOverride: FIXED_ISM,
          userSalt: c.userSalt,
        },
      });

      expect(result.toString()).to.equal('110000');
      expect(mockDestRouter.estimateGas.handle.firstCall.args[2]).to.equal(
        c.expectedBody,
      );
      expect(mockDestRouter.bytecodeHash.callCount).to.equal(
        c.saltedLookupMissing ? 1 : 0,
      );
    });
  }

  it('rethrows non-selector bytecodeHash failures', async () => {
    const rpcError = Object.assign(new Error('RPC unavailable'), {
      code: 'CALL_EXCEPTION',
      data: '0x',
      error: { code: -32000, message: 'header not found' },
    });
    configureRouter({ saltedLookupMissing: true, bytecodeHashMissing: false });
    mockDestRouter.bytecodeHash.rejects(rpcError);

    const caught = await app
      .estimateIcaHandleGas({
        origin: chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: baseConfig,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(caught).to.equal(rpcError);
    sinon.assert.notCalled(mockDestRouter.estimateGas.handle);
  });

  it('rejects a user salt on routers without the salted lookup', async () => {
    const missingSelector = missingSelectorError();
    mockDestRouter[
      'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
    ].rejects(missingSelector);

    const caught = await app
      .estimateIcaHandleGas({
        origin: chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: {
          origin: chain,
          owner: FIXED_OWNER,
          localRouter: fixedLocalRouter,
          userSalt: FIXED_SALT,
        },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(caught).to.equal(missingSelector);
    sinon.assert.notCalled(mockDestRouter.bytecodeHash);
  });

  interface DeploymentCase {
    name: string;
    bytecodeHashMissing: boolean;
    userSalt?: string;
    deployOverload: typeof legacyDeploy | typeof saltedDeploy;
    expectedDeployArgs: (string | number)[];
    expectedGas: string;
  }

  const deploymentCases: DeploymentCase[] = [
    {
      name: 'adds legacy ICA deployment gas for an undeployed ICA on pre-8.0.0 routers',
      bytecodeHashMissing: true,
      deployOverload: legacyDeploy,
      expectedDeployArgs: [FIXED_OWNER, fixedLocalRouter, FIXED_ISM],
      // (30k call + 92k deploy + 50k ICA + 5k per-call) * 1.1
      expectedGas: '194700',
    },
    {
      name: 'adds salted ICA deployment gas for an undeployed ICA on 8.0.0+ routers',
      bytecodeHashMissing: false,
      userSalt: FIXED_SALT,
      deployOverload: saltedDeploy,
      expectedDeployArgs: [
        addressToBytes32(FIXED_OWNER),
        addressToBytes32(fixedLocalRouter),
        FIXED_ISM,
        FIXED_SALT,
      ],
      expectedGas: '194700',
    },
  ];

  for (const c of deploymentCases) {
    it(c.name, async () => {
      if (c.bytecodeHashMissing) {
        configureRouter({
          saltedLookupMissing: true,
          bytecodeHashMissing: true,
        });
      }
      mockDestRouter.estimateGas.handle.rejects(new Error('handle failed'));
      mockProvider.estimateGas.resolves(BigNumber.from(30_000));
      mockProvider.getCode.resolves('0x');
      mockDestRouter.estimateGas[c.deployOverload].resolves(
        BigNumber.from(92_000),
      );

      const result = await app.estimateIcaHandleGas({
        origin: chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: {
          origin: chain,
          owner: FIXED_OWNER,
          localRouter: fixedLocalRouter,
          ismOverride: FIXED_ISM,
          userSalt: c.userSalt,
        },
      });

      expect(result.toString()).to.equal(c.expectedGas);
      sinon.assert.calledOnceWithExactly(
        mockProvider.getCode,
        destinationAccount,
      );
      sinon.assert.calledOnceWithExactly(
        mockDestRouter.estimateGas[c.deployOverload],
        multiProvider.getDomainId(chain),
        ...c.expectedDeployArgs,
      );
      sinon.assert.notCalled(
        mockDestRouter.estimateGas[
          c.deployOverload === legacyDeploy ? saltedDeploy : legacyDeploy
        ],
      );
    });
  }

  it('adds no deployment gas when the ICA already has code', async () => {
    mockDestRouter.estimateGas.handle.rejects(new Error('handle failed'));
    mockProvider.estimateGas.resolves(BigNumber.from(30_000));

    const result = await app.estimateIcaHandleGas({
      origin: chain,
      destination,
      innerCalls: [FIXED_CALL],
      config: baseConfig,
    });

    // (30k call + 50k ICA + 5k per-call) * 1.1
    expect(result.toString()).to.equal('93500');
    sinon.assert.calledOnce(mockProvider.getCode);
    sinon.assert.notCalled(mockDestRouter.estimateGas[legacyDeploy]);
    sinon.assert.notCalled(mockDestRouter.estimateGas[saltedDeploy]);
  });

  interface DeploymentFailureCase {
    name: string;
    failGetCode: boolean;
    expectedWarning: string;
  }

  const deploymentFailureCases: DeploymentFailureCase[] = [
    {
      name: 'adds the deployment gas fallback when the deployment estimate fails',
      failGetCode: false,
      expectedWarning:
        'Failed to estimate ICA deployment gas, using the deployment gas fallback',
    },
    {
      name: 'adds the deployment gas fallback without a deployment estimate when getCode fails',
      failGetCode: true,
      expectedWarning:
        'Failed to check ICA deployment, assuming it is undeployed and using the deployment gas fallback',
    },
  ];

  for (const c of deploymentFailureCases) {
    it(c.name, async () => {
      mockDestRouter.estimateGas.handle.rejects(new Error('handle failed'));
      mockProvider.estimateGas.resolves(BigNumber.from(30_000));
      if (c.failGetCode) {
        mockProvider.getCode.rejects(createRpcError());
      } else {
        mockProvider.getCode.resolves('0x');
        mockDestRouter.estimateGas[saltedDeploy].rejects(createRpcError());
      }
      const warn = sandbox.spy(app.logger, 'warn');

      const result = await app.estimateIcaHandleGas({
        origin: chain,
        destination,
        innerCalls: [FIXED_CALL],
        config: baseConfig,
      });

      // (30k call + 150k deployment fallback + 50k ICA + 5k per-call) * 1.1
      expect(result.toString()).to.equal('258500');
      const warnCall = warn
        .getCalls()
        .find((call) => call.args[1] === c.expectedWarning);
      assert(warnCall, `Expected warning: ${c.expectedWarning}`);
      expect(warnCall.args[0]).to.deep.equal({
        destination,
        destinationAccount,
        error: REDACTED_RPC_ERROR_MESSAGE,
      });
      sinon.assert.notCalled(mockDestRouter.estimateGas[legacyDeploy]);
      if (c.failGetCode) {
        sinon.assert.notCalled(mockDestRouter.estimateGas[saltedDeploy]);
      } else {
        sinon.assert.calledOnce(mockDestRouter.estimateGas[saltedDeploy]);
      }
    });
  }
});

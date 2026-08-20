import { expect } from 'chai';
import { BigNumber, constants } from 'ethers';
import sinon from 'sinon';

import {
  AbstractRoutingIsm__factory,
  AmountRoutingIsm,
  AmountRoutingIsm__factory,
  BlacklistIsm,
  BlacklistIsm__factory,
  CCIPIsm,
  CCIPIsm__factory,
  DefaultFallbackRoutingIsm,
  DefaultFallbackRoutingIsm__factory,
  DefaultIsm,
  DefaultIsm__factory,
  DelayedFlowRouterHookIsm,
  DelayedFlowRouterHookIsm__factory,
  DomainRoutingIsm__factory,
  IInterchainSecurityModule,
  IInterchainSecurityModule__factory,
  IMultisigIsm,
  IMultisigIsm__factory,
  IncrementalDomainRoutingIsm__factory,
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  NetFlowRateLimitedHookIsm,
  NetFlowRateLimitedHookIsm__factory,
  OPStackIsm,
  OPStackIsm__factory,
  Ownable__factory,
  PausableIsm,
  PausableIsm__factory,
  RateLimitedIsm,
  RateLimitedIsm__factory,
  TestIsm,
  TestIsm__factory,
  TrustedRelayerIsm,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import { WithAddress, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { TestChainName, test2 } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import { contractDouble } from '../test/contractDouble.js';
import { missingSelectorError, networkError } from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import {
  BlacklistIsmConfig,
  DelayedFlowRouterHookIsmConfig,
  InterchainAccountRouterIsm,
  IsmType,
  MailboxDefaultIsmConfig,
  ModuleType,
  MultisigIsmConfig,
  NetFlowRateLimitedHookIsmConfig,
  PausableIsmConfig,
  TestIsmConfig,
} from './types.js';

// keccak256('MessageBlacklisted(bytes32)')
const MESSAGE_BLACKLISTED_TOPIC =
  '0x6fdaf3cd8c245bcc67646386e905ab1e2e12ec4d669c2f66c2ce2e0b55e2ce74';

const LEGACY_BLACKLIST_ADDRESS = '0x5d4C14B895392BD935583ebFfE0f5159540FE8bC';

function messageBlacklistedLog(
  blacklistedId: string,
  blockNumber: number,
  logIndex: number,
): GetEventLogsResponse {
  return {
    address: LEGACY_BLACKLIST_ADDRESS,
    blockNumber,
    data: '0x',
    logIndex,
    topics: [MESSAGE_BLACKLISTED_TOPIC, blacklistedId],
    transactionHash:
      '0x9fc76417374aa880d4449a1f7f31ec597f00b1f6f3dd2d66f4c9c6c445836d8b',
    transactionIndex: 0,
  };
}

// As many logs as an Etherscan-like explorer returns in a single page.
function fullLogPage(): GetEventLogsResponse[] {
  return Array.from({ length: 1000 }, (_, index) =>
    messageBlacklistedLog(
      `0x${index.toString(16).padStart(64, '0')}`,
      100 + index,
      0,
    ),
  );
}

// Stubs every NULL-type probe that `deriveNullConfig` attempts before the
// blacklist one, so each test only has to define the blacklist double.
function stubProbesBeforeBlacklist(sandbox: sinon.SinonSandbox): void {
  sandbox.stub(TrustedRelayerIsm__factory, 'connect').returns(
    contractDouble<TrustedRelayerIsm>({
      trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
    }),
  );
  sandbox.stub(PausableIsm__factory, 'connect').returns(
    contractDouble<PausableIsm>({
      paused: sandbox.stub().rejects(missingSelectorError()),
      owner: sandbox.stub().rejects(missingSelectorError()),
    }),
  );
  sandbox.stub(CCIPIsm__factory, 'connect').returns(
    contractDouble<CCIPIsm>({
      ccipOrigin: sandbox.stub().rejects(missingSelectorError()),
    }),
  );
  sandbox.stub(OPStackIsm__factory, 'connect').returns(
    contractDouble<OPStackIsm>({
      VERIFIED_MASK_INDEX: sandbox.stub().rejects(missingSelectorError()),
    }),
  );
  sandbox.stub(RateLimitedIsm__factory, 'connect').returns(
    contractDouble<RateLimitedIsm>({
      recipient: sandbox.stub().rejects(missingSelectorError()),
    }),
  );
  sandbox.stub(IInterchainSecurityModule__factory, 'connect').returns(
    contractDouble<IInterchainSecurityModule>({
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
    }),
  );
}

describe('EvmIsmReader', () => {
  let evmIsmReader: EvmIsmReader;
  let multiProvider: MultiProvider;
  let sandbox: sinon.SinonSandbox;
  let getContractDeploymentBlockFromExplorer: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
    evmIsmReader = new EvmIsmReader(multiProvider, TestChainName.test1);
    getContractDeploymentBlockFromExplorer = sandbox
      .stub(
        EvmEventLogsReader.prototype,
        'getContractDeploymentBlockFromExplorer',
      )
      .resolves(100);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should derive multisig config correctly', async () => {
    const mockAddress = randomAddress();
    const mockValidators = [randomAddress(), randomAddress()];
    const mockThreshold = 2;

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.MESSAGE_ID_MULTISIG),
      validatorsAndThreshold: sandbox
        .stub()
        .resolves([mockValidators, mockThreshold]),
    };
    sandbox
      .stub(IMultisigIsm__factory, 'connect')
      .returns(mockContract as unknown as IMultisigIsm);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);

    const expectedConfig: WithAddress<MultisigIsmConfig> = {
      address: mockAddress,
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: mockValidators,
      threshold: mockThreshold,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveMultisigConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  it('should derive pausable config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockPaused = true;

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
      owner: sandbox.stub().resolves(mockOwner),
      paused: sandbox.stub().resolves(mockPaused),
      trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
    };
    sandbox
      .stub(PausableIsm__factory, 'connect')
      .returns(mockContract as unknown as PausableIsm);
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(mockContract as unknown as TrustedRelayerIsm);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);

    const expectedConfig: WithAddress<PausableIsmConfig> = {
      address: mockAddress,
      owner: mockOwner,
      type: IsmType.PAUSABLE,
      paused: mockPaused,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveNullConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  it('should derive test ISM config correctly', async () => {
    const mockAddress = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
      trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
      paused: sandbox.stub().rejects(missingSelectorError()),
      owner: sandbox.stub().rejects(missingSelectorError()),
      ccipOrigin: sandbox.stub().rejects(missingSelectorError()),
      VERIFIED_MASK_INDEX: sandbox.stub().rejects(missingSelectorError()),
      recipient: sandbox.stub().rejects(missingSelectorError()),
      blacklistedIds: sandbox.stub().rejects(missingSelectorError()),
      warpRouter: sandbox.stub().rejects(missingSelectorError()),
    };
    sandbox
      .stub(TestIsm__factory, 'connect')
      .returns(mockContract as unknown as TestIsm);
    sandbox
      .stub(OPStackIsm__factory, 'connect')
      .returns(mockContract as unknown as OPStackIsm);
    sandbox
      .stub(PausableIsm__factory, 'connect')
      .returns(mockContract as unknown as PausableIsm);
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(mockContract as unknown as TrustedRelayerIsm);
    sandbox
      .stub(CCIPIsm__factory, 'connect')
      .returns(mockContract as unknown as CCIPIsm);
    sandbox
      .stub(RateLimitedIsm__factory, 'connect')
      .returns(mockContract as unknown as RateLimitedIsm);
    sandbox
      .stub(BlacklistIsm__factory, 'connect')
      .returns(contractDouble<BlacklistIsm>(mockContract));
    sandbox
      .stub(NetFlowRateLimitedHookIsm__factory, 'connect')
      .returns(contractDouble<NetFlowRateLimitedHookIsm>(mockContract));
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);

    const expectedConfig: WithAddress<TestIsmConfig> = {
      address: mockAddress,
      type: IsmType.TEST_ISM,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveNullConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  it('should derive blacklist ISM config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockBlacklistedIds = [
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    ];

    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
      blacklistedIds: sandbox.stub().resolves(false),
      values: sandbox.stub().resolves(mockBlacklistedIds),
      owner: sandbox.stub().resolves(mockOwner),
    };
    sandbox.stub(TrustedRelayerIsm__factory, 'connect').returns(
      contractDouble<TrustedRelayerIsm>({
        trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(PausableIsm__factory, 'connect').returns(
      contractDouble<PausableIsm>({
        paused: sandbox.stub().rejects(missingSelectorError()),
        owner: sandbox.stub().resolves(mockOwner),
      }),
    );
    sandbox.stub(CCIPIsm__factory, 'connect').returns(
      contractDouble<CCIPIsm>({
        ccipOrigin: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(OPStackIsm__factory, 'connect').returns(
      contractDouble<OPStackIsm>({
        VERIFIED_MASK_INDEX: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(RateLimitedIsm__factory, 'connect').returns(
      contractDouble<RateLimitedIsm>({
        recipient: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox
      .stub(BlacklistIsm__factory, 'connect')
      .returns(contractDouble<BlacklistIsm>(mockContract));
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(contractDouble<IInterchainSecurityModule>(mockContract));

    const expectedConfig: WithAddress<BlacklistIsmConfig> = {
      address: mockAddress,
      type: IsmType.BLACKLIST,
      owner: mockOwner,
      blacklistedIds: mockBlacklistedIds,
    };

    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    const config = await evmIsmReader.deriveNullConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  it('should derive a legacy blacklist ISM config from event logs', async () => {
    const mockOwner = randomAddress();
    const firstId =
      '0x3333333333333333333333333333333333333333333333333333333333333333';
    const secondId =
      '0x1111111111111111111111111111111111111111111111111111111111111111';

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        values: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    // The legacy contract emits on every entry, including re-adds, so the same
    // ID can appear more than once.
    const getLogsByTopic = sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
      .resolves([
        messageBlacklistedLog(firstId, 100, 0),
        messageBlacklistedLog(secondId, 120, 1),
        messageBlacklistedLog(firstId, 140, 0),
      ]);

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    const expectedConfig: WithAddress<BlacklistIsmConfig> = {
      address: LEGACY_BLACKLIST_ADDRESS,
      type: IsmType.BLACKLIST,
      owner: mockOwner,
      blacklistedIds: [secondId, firstId],
    };
    expect(config).to.deep.equal(expectedConfig);
    expect(getLogsByTopic.calledOnce).to.be.true;
    expect(getLogsByTopic.firstCall.args[0]).to.deep.equal({
      contractAddress: LEGACY_BLACKLIST_ADDRESS,
      eventTopic: MESSAGE_BLACKLISTED_TOPIC,
      fromBlock: 100,
    });
    expect(
      getContractDeploymentBlockFromExplorer.calledOnceWithExactly(
        LEGACY_BLACKLIST_ADDRESS,
      ),
    ).to.be.true;
  });

  // The counterpart to the failure cases below: no events is a readable, empty
  // set, and must never be conflated with an unreadable one.
  it('should normalize the ids an enumerable blacklist ISM returns', async () => {
    const mockOwner = randomAddress();
    const lowerId =
      '0x1111111111111111111111111111111111111111111111111111111111111111';
    const upperId =
      '0x2222222222222222222222222222222222222222222222222222222222222222';

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        // Unsorted, mixed case, and repeated — the shape a contract can return.
        values: sandbox
          .stub()
          .resolves([upperId.toUpperCase(), lowerId, upperId.toUpperCase()]),
      }),
    );

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    assert(
      config.type === IsmType.BLACKLIST,
      'expected a blacklist ISM config',
    );
    // Same shape the log replay produces, so neither source is identifiable
    // from the result.
    expect(config.blacklistedIds).to.deep.equal([lowerId, upperId]);
  });

  it('should derive an empty set for a legacy blacklist ISM with no events', async () => {
    const mockOwner = randomAddress();

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        values: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(EvmEventLogsReader.prototype, 'getLogsByTopic').resolves([]);

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    const expectedConfig: WithAddress<BlacklistIsmConfig> = {
      address: LEGACY_BLACKLIST_ADDRESS,
      type: IsmType.BLACKLIST,
      owner: mockOwner,
      blacklistedIds: [],
    };
    expect(config).to.deep.equal(expectedConfig);
  });

  // An unreadable set is a failure, not an empty set: the contract is a
  // Blacklist ISM, so a config that omits its entries would misdescribe it.
  const unreadableCases: { name: string; error: () => Error }[] = [
    { name: 'the logs cannot be read', error: networkError },
    {
      name: 'the address is not a contract',
      error: () =>
        new Error(
          `Address "${LEGACY_BLACKLIST_ADDRESS}" on chain "test1" is not a contract`,
        ),
    },
  ];

  for (const unreadable of unreadableCases) {
    it(`should fail when ${unreadable.name}`, async () => {
      const readError = unreadable.error();

      stubProbesBeforeBlacklist(sandbox);
      sandbox.stub(BlacklistIsm__factory, 'connect').returns(
        contractDouble<BlacklistIsm>({
          blacklistedIds: sandbox.stub().resolves(false),
          owner: sandbox.stub().resolves(randomAddress()),
          values: sandbox.stub().rejects(missingSelectorError()),
        }),
      );
      sandbox
        .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
        .rejects(readError);

      let thrown: unknown;
      try {
        await evmIsmReader.deriveNullConfig(LEGACY_BLACKLIST_ADDRESS);
      } catch (error) {
        thrown = error;
      }

      assert(thrown instanceof Error, 'expected the derivation to fail');
      expect(thrown.message).to.include(LEGACY_BLACKLIST_ADDRESS);
      expect(thrown.message).to.include('test1');
      expect(thrown.cause).to.equal(readError);
    });
  }

  // The reader returns a complete set or fails, so a set is never discarded for
  // its size.
  it('should keep a full page of legacy blacklist logs', async () => {
    const mockOwner = randomAddress();

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        values: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    const logs = fullLogPage();
    sandbox.stub(EvmEventLogsReader.prototype, 'getLogsByTopic').resolves(logs);

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    assert(
      config.type === IsmType.BLACKLIST,
      'expected a blacklist ISM config',
    );
    expect(config.blacklistedIds).to.have.lengthOf(logs.length);
  });

  it('should not read logs for an enumerable blacklist ISM', async () => {
    const mockOwner = randomAddress();
    const onChainId =
      '0x2222222222222222222222222222222222222222222222222222222222222222';

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        values: sandbox.stub().resolves([onChainId]),
      }),
    );
    const getLogsByTopic = sandbox.stub(
      EvmEventLogsReader.prototype,
      'getLogsByTopic',
    );

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    const expectedConfig: WithAddress<BlacklistIsmConfig> = {
      address: LEGACY_BLACKLIST_ADDRESS,
      type: IsmType.BLACKLIST,
      owner: mockOwner,
      blacklistedIds: [onChainId],
    };
    expect(config).to.deep.equal(expectedConfig);
    expect(getLogsByTopic.notCalled).to.be.true;
    expect(getContractDeploymentBlockFromExplorer.notCalled).to.be.true;
  });

  it('should not classify transient blacklist owner failures as test ISM', async () => {
    const transientError = networkError();

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().rejects(transientError),
      }),
    );

    let thrown: unknown;
    try {
      await evmIsmReader.deriveNullConfig(LEGACY_BLACKLIST_ADDRESS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('should not classify transient blacklist values failures as legacy', async () => {
    const transientError = networkError();

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(randomAddress()),
        values: sandbox.stub().rejects(transientError),
      }),
    );
    const getLogsByTopic = sandbox.stub(
      EvmEventLogsReader.prototype,
      'getLogsByTopic',
    );

    let thrown: unknown;
    try {
      await evmIsmReader.deriveNullConfig(LEGACY_BLACKLIST_ADDRESS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
    expect(getLogsByTopic.notCalled).to.be.true;
  });

  it('should derive net flow rate limited hook ISM config correctly', async () => {
    const mockAddress = randomAddress();
    const mockWarpRouter = randomAddress();
    const mockOwner = randomAddress();

    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
      trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
      paused: sandbox.stub().rejects(missingSelectorError()),
      ccipOrigin: sandbox.stub().rejects(missingSelectorError()),
      VERIFIED_MASK_INDEX: sandbox.stub().rejects(missingSelectorError()),
      recipient: sandbox.stub().rejects(missingSelectorError()),
      blacklistedIds: sandbox.stub().rejects(missingSelectorError()),
      maxDelay: sandbox.stub().rejects(missingSelectorError()),
      warpRouter: sandbox.stub().resolves(mockWarpRouter),
      thresholdBps: sandbox.stub().resolves(BigNumber.from(500)),
      DURATION: sandbox.stub().resolves(BigNumber.from(86400)),
      owner: sandbox.stub().resolves(mockOwner),
    };
    sandbox
      .stub(PausableIsm__factory, 'connect')
      .returns(contractDouble<PausableIsm>(mockContract));
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(contractDouble<TrustedRelayerIsm>(mockContract));
    sandbox
      .stub(OPStackIsm__factory, 'connect')
      .returns(contractDouble<OPStackIsm>(mockContract));
    sandbox
      .stub(CCIPIsm__factory, 'connect')
      .returns(contractDouble<CCIPIsm>(mockContract));
    sandbox
      .stub(RateLimitedIsm__factory, 'connect')
      .returns(contractDouble<RateLimitedIsm>(mockContract));
    sandbox
      .stub(BlacklistIsm__factory, 'connect')
      .returns(contractDouble<BlacklistIsm>(mockContract));
    sandbox
      .stub(NetFlowRateLimitedHookIsm__factory, 'connect')
      .returns(contractDouble<NetFlowRateLimitedHookIsm>(mockContract));
    sandbox
      .stub(DelayedFlowRouterHookIsm__factory, 'connect')
      .returns(contractDouble<DelayedFlowRouterHookIsm>(mockContract));
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(contractDouble<IInterchainSecurityModule>(mockContract));

    const expectedConfig: WithAddress<NetFlowRateLimitedHookIsmConfig> = {
      address: mockAddress,
      type: IsmType.NET_FLOW_RATE_LIMITED,
      warpRouter: mockWarpRouter,
      thresholdBps: 500,
      duration: 86400n,
      owner: mockOwner,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveNullConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  it('should not classify transient blacklist probe failures as test ISM', async () => {
    const mockAddress = randomAddress();
    const transientError = networkError();

    sandbox.stub(TrustedRelayerIsm__factory, 'connect').returns(
      contractDouble<TrustedRelayerIsm>({
        trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(PausableIsm__factory, 'connect').returns(
      contractDouble<PausableIsm>({
        paused: sandbox.stub().rejects(missingSelectorError()),
        owner: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(CCIPIsm__factory, 'connect').returns(
      contractDouble<CCIPIsm>({
        ccipOrigin: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(OPStackIsm__factory, 'connect').returns(
      contractDouble<OPStackIsm>({
        VERIFIED_MASK_INDEX: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(RateLimitedIsm__factory, 'connect').returns(
      contractDouble<RateLimitedIsm>({
        recipient: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().rejects(transientError),
      }),
    );
    sandbox.stub(IInterchainSecurityModule__factory, 'connect').returns(
      contractDouble<IInterchainSecurityModule>({
        moduleType: sandbox.stub().resolves(ModuleType.NULL),
      }),
    );

    let thrown: unknown;
    try {
      await evmIsmReader.deriveNullConfig(mockAddress);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('should derive delayed flow router hook ISM config correctly', async () => {
    const mockAddress = randomAddress();
    const mockWarpRouter = randomAddress();
    const mockOwner = randomAddress();
    const mockRemoteRouter = addressToBytes32(randomAddress()).toLowerCase();

    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
      trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
      paused: sandbox.stub().rejects(missingSelectorError()),
      ccipOrigin: sandbox.stub().rejects(missingSelectorError()),
      VERIFIED_MASK_INDEX: sandbox.stub().rejects(missingSelectorError()),
      recipient: sandbox.stub().rejects(missingSelectorError()),
      blacklistedIds: sandbox.stub().rejects(missingSelectorError()),
      warpRouter: sandbox.stub().resolves(mockWarpRouter),
      maxDelay: sandbox.stub().resolves(3600),
      thresholdBps: sandbox.stub().resolves(BigNumber.from(10000)),
      DURATION: sandbox.stub().resolves(BigNumber.from(86400)),
      owner: sandbox.stub().resolves(mockOwner),
      domains: sandbox.stub().resolves([test2.domainId]),
      routers: sandbox.stub().resolves(mockRemoteRouter),
    };
    sandbox
      .stub(PausableIsm__factory, 'connect')
      .returns(contractDouble<PausableIsm>(mockContract));
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(contractDouble<TrustedRelayerIsm>(mockContract));
    sandbox
      .stub(OPStackIsm__factory, 'connect')
      .returns(contractDouble<OPStackIsm>(mockContract));
    sandbox
      .stub(CCIPIsm__factory, 'connect')
      .returns(contractDouble<CCIPIsm>(mockContract));
    sandbox
      .stub(RateLimitedIsm__factory, 'connect')
      .returns(contractDouble<RateLimitedIsm>(mockContract));
    sandbox
      .stub(BlacklistIsm__factory, 'connect')
      .returns(contractDouble<BlacklistIsm>(mockContract));
    sandbox
      .stub(NetFlowRateLimitedHookIsm__factory, 'connect')
      .returns(contractDouble<NetFlowRateLimitedHookIsm>(mockContract));
    sandbox
      .stub(DelayedFlowRouterHookIsm__factory, 'connect')
      .returns(contractDouble<DelayedFlowRouterHookIsm>(mockContract));
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(contractDouble<IInterchainSecurityModule>(mockContract));

    const expectedConfig: WithAddress<DelayedFlowRouterHookIsmConfig> = {
      address: mockAddress,
      type: IsmType.DELAYED_FLOW_ROUTER,
      warpRouter: mockWarpRouter,
      thresholdBps: 10000,
      maxDelay: 3600,
      duration: 86400n,
      owner: mockOwner,
      remoteIsms: { [TestChainName.test2]: mockRemoteRouter },
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveNullConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  it('should still derive a rate limited ISM before probing for hybrids', async () => {
    const mockAddress = randomAddress();
    const mockRecipient = randomAddress();
    const mockOwner = randomAddress();

    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
      trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
      paused: sandbox.stub().rejects(missingSelectorError()),
      ccipOrigin: sandbox.stub().rejects(missingSelectorError()),
      VERIFIED_MASK_INDEX: sandbox.stub().rejects(missingSelectorError()),
      recipient: sandbox.stub().resolves(mockRecipient),
      maxCapacity: sandbox.stub().resolves(BigNumber.from('86400')),
      DURATION: sandbox.stub().resolves(BigNumber.from(86400)),
      owner: sandbox.stub().resolves(mockOwner),
      warpRouter: sandbox.stub().rejects(missingSelectorError()),
    };
    sandbox
      .stub(PausableIsm__factory, 'connect')
      .returns(contractDouble<PausableIsm>(mockContract));
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(contractDouble<TrustedRelayerIsm>(mockContract));
    sandbox
      .stub(OPStackIsm__factory, 'connect')
      .returns(contractDouble<OPStackIsm>(mockContract));
    sandbox
      .stub(CCIPIsm__factory, 'connect')
      .returns(contractDouble<CCIPIsm>(mockContract));
    sandbox
      .stub(RateLimitedIsm__factory, 'connect')
      .returns(contractDouble<RateLimitedIsm>(mockContract));
    sandbox
      .stub(BlacklistIsm__factory, 'connect')
      .returns(contractDouble<BlacklistIsm>(mockContract));
    sandbox
      .stub(NetFlowRateLimitedHookIsm__factory, 'connect')
      .returns(contractDouble<NetFlowRateLimitedHookIsm>(mockContract));
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(contractDouble<IInterchainSecurityModule>(mockContract));

    const config = await evmIsmReader.deriveNullConfig(mockAddress);
    expect(config).to.deep.equal({
      address: mockAddress,
      type: IsmType.RATE_LIMITED,
      maxCapacity: '86400',
      duration: 86400n,
      owner: mockOwner,
    });
  });

  it('should derive mailbox default ISM config correctly', async () => {
    const mockAddress = randomAddress();
    const mockMailbox = randomAddress();

    sandbox.stub(AbstractRoutingIsm__factory, 'connect').returns(
      contractDouble<InterchainAccountRouter>({
        moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
      }),
    );
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns(
      contractDouble<InterchainAccountRouter>({
        CCIP_READ_ISM: sandbox.stub().rejects(missingSelectorError()),
        bytecodeHash: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(Ownable__factory, 'connect').returns(
      contractDouble<InterchainAccountRouter>({
        owner: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(AmountRoutingIsm__factory, 'connect').returns(
      contractDouble<AmountRoutingIsm>({
        lower: sandbox.stub().rejects(missingSelectorError()),
        upper: sandbox.stub().rejects(missingSelectorError()),
        threshold: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(DefaultIsm__factory, 'connect').returns(
      contractDouble<DefaultIsm>({
        mailbox: sandbox.stub().resolves(mockMailbox),
      }),
    );
    sandbox.stub(IInterchainSecurityModule__factory, 'connect').returns(
      contractDouble<IInterchainSecurityModule>({
        moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
      }),
    );

    const expectedConfig: WithAddress<MailboxDefaultIsmConfig> = {
      address: mockAddress,
      type: IsmType.MAILBOX_DEFAULT,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveRoutingConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  it('should still derive a legacy ICA ism when the mailbox probe misses', async () => {
    const mockAddress = randomAddress();

    sandbox.stub(AbstractRoutingIsm__factory, 'connect').returns(
      contractDouble<InterchainAccountRouter>({
        moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
      }),
    );
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns(
      contractDouble<InterchainAccountRouter>({
        CCIP_READ_ISM: sandbox.stub().rejects(missingSelectorError()),
        bytecodeHash: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(Ownable__factory, 'connect').returns(
      contractDouble<InterchainAccountRouter>({
        owner: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(AmountRoutingIsm__factory, 'connect').returns(
      contractDouble<AmountRoutingIsm>({
        lower: sandbox.stub().rejects(missingSelectorError()),
        upper: sandbox.stub().rejects(missingSelectorError()),
        threshold: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox.stub(DefaultIsm__factory, 'connect').returns(
      contractDouble<DefaultIsm>({
        mailbox: sandbox.stub().rejects(missingSelectorError()),
      }),
    );

    const config = await evmIsmReader.deriveRoutingConfig(mockAddress);
    expect(config).to.deep.equal({
      type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
      isms: {},
      address: mockAddress,
      owner: constants.AddressZero,
    });
  });

  it('should not classify transient pausable probe failures as test ISM', async () => {
    const mockAddress = randomAddress();
    const transientError = networkError();

    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
      trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
      paused: sandbox.stub().resolves(false),
      owner: sandbox.stub().rejects(transientError),
    };
    sandbox
      .stub(PausableIsm__factory, 'connect')
      .returns(mockContract as unknown as PausableIsm);
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(mockContract as unknown as TrustedRelayerIsm);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);

    let thrown: unknown;
    try {
      await evmIsmReader.deriveNullConfig(mockAddress);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('should prioritize transient pausable probe failures over missing selectors', async () => {
    const mockAddress = randomAddress();
    const transientError = networkError();

    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.NULL),
      trustedRelayer: sandbox.stub().rejects(missingSelectorError()),
      paused: sandbox.stub().rejects(missingSelectorError()),
      owner: sandbox.stub().rejects(transientError),
    };
    sandbox
      .stub(PausableIsm__factory, 'connect')
      .returns(mockContract as unknown as PausableIsm);
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(mockContract as unknown as TrustedRelayerIsm);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);

    let thrown: unknown;
    try {
      await evmIsmReader.deriveNullConfig(mockAddress);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('should not treat transient routing owner failures as non-ownable routing', async () => {
    const mockAddress = randomAddress();
    const transientError = networkError();

    sandbox.stub(AbstractRoutingIsm__factory, 'connect').returns({
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
    } as any);
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns({
      CCIP_READ_ISM: sandbox.stub().rejects(missingSelectorError()),
      bytecodeHash: sandbox.stub().rejects(missingSelectorError()),
    } as any);
    sandbox.stub(Ownable__factory, 'connect').returns({
      owner: sandbox.stub().rejects(transientError),
    } as any);

    let thrown: unknown;
    try {
      await evmIsmReader.deriveRoutingConfig(mockAddress);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('should not treat transient ICA probe failures as non-ICA routing', async () => {
    const mockAddress = randomAddress();
    const transientError = networkError();

    sandbox.stub(AbstractRoutingIsm__factory, 'connect').returns({
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
    } as any);
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns({
      CCIP_READ_ISM: sandbox.stub().rejects(transientError),
    } as any);

    let thrown: unknown;
    try {
      await evmIsmReader.deriveRoutingConfig(mockAddress);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('should not classify transient AmountRoutingIsm probe failures as legacy ICA', async () => {
    const mockAddress = randomAddress();
    const transientError = networkError();

    sandbox.stub(AbstractRoutingIsm__factory, 'connect').returns({
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
    } as any);
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns({
      CCIP_READ_ISM: sandbox.stub().rejects(missingSelectorError()),
      bytecodeHash: sandbox.stub().rejects(missingSelectorError()),
    } as any);
    sandbox.stub(Ownable__factory, 'connect').returns({
      owner: sandbox.stub().rejects(missingSelectorError()),
    } as any);
    sandbox.stub(AmountRoutingIsm__factory, 'connect').returns({
      lower: sandbox.stub().rejects(transientError),
      upper: sandbox.stub().resolves(randomAddress()),
      threshold: sandbox.stub().resolves(1),
    } as unknown as AmountRoutingIsm);

    let thrown: unknown;
    try {
      await evmIsmReader.deriveRoutingConfig(mockAddress);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('should not treat transient fallback mailbox failures as plain routing', async () => {
    const mockAddress = randomAddress();
    const transientError = networkError();

    sandbox.stub(AbstractRoutingIsm__factory, 'connect').returns({
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
    } as any);
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns({
      CCIP_READ_ISM: sandbox.stub().rejects(missingSelectorError()),
      bytecodeHash: sandbox.stub().rejects(missingSelectorError()),
    } as any);
    sandbox.stub(Ownable__factory, 'connect').returns({
      owner: sandbox.stub().resolves(randomAddress()),
    } as any);
    sandbox.stub(DefaultFallbackRoutingIsm__factory, 'connect').returns({
      domains: sandbox.stub().resolves([]),
      mailbox: sandbox.stub().rejects(transientError),
    } as any);

    let thrown: unknown;
    try {
      await evmIsmReader.deriveRoutingConfig(mockAddress);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('should derive the ICA ism correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockccipIsm = randomAddress();
    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
      owner: sandbox.stub().resolves(mockOwner),
      CCIP_READ_ISM: sandbox.stub().resolves(mockccipIsm),
    };
    const mockDefaultFallbackContract = {
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
      owner: sandbox.stub().resolves(mockOwner),
      domains: sandbox.stub().resolves([]),
    };
    sandbox
      .stub(AbstractRoutingIsm__factory, 'connect')
      .returns(mockContract as unknown as InterchainAccountRouter);
    sandbox
      .stub(InterchainAccountRouter__factory, 'connect')
      .returns(mockContract as unknown as InterchainAccountRouter);
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(mockContract as unknown as TrustedRelayerIsm);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);
    sandbox.stub(Ownable__factory, 'connect').returns(mockContract as any);
    sandbox
      .stub(DefaultFallbackRoutingIsm__factory, 'connect')
      .returns(
        mockDefaultFallbackContract as unknown as DefaultFallbackRoutingIsm,
      );

    const expectedConfig: WithAddress<InterchainAccountRouterIsm> = {
      address: mockAddress,
      type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
      isms: {},
      owner: mockOwner,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveRoutingConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  it('should derive incremental routing ISM config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockDomain = 1;
    const mockModule = randomAddress();

    // Mock the routing ISM contract
    const mockRoutingContract = {
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
      owner: sandbox.stub().resolves(mockOwner),
      domains: sandbox.stub().resolves([mockDomain]),
      module: sandbox.stub().resolves(mockModule),
    };

    // Mock fallback routing to fail mailbox() call
    const mockFallbackContract = {
      mailbox: sandbox.stub().rejects(missingSelectorError()),
      domains: sandbox.stub().resolves([BigNumber.from(mockDomain)]),
      module: sandbox.stub().resolves(mockModule),
    };

    const mockProvider = evmIsmReader['provider'];
    sandbox
      .stub(mockProvider, 'getCode')
      .resolves(IncrementalDomainRoutingIsm__factory.bytecode);

    sandbox
      .stub(AbstractRoutingIsm__factory, 'connect')
      .returns(mockRoutingContract as any);
    sandbox
      .stub(Ownable__factory, 'connect')
      .returns({ owner: sandbox.stub().resolves(mockOwner) } as any);
    sandbox
      .stub(DefaultFallbackRoutingIsm__factory, 'connect')
      .returns(mockFallbackContract as any);
    sandbox
      .stub(DomainRoutingIsm__factory, 'connect')
      .returns(mockRoutingContract as any);
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns({
      CCIP_READ_ISM: sandbox.stub().rejects(missingSelectorError()),
      bytecodeHash: sandbox.stub().rejects(missingSelectorError()),
    } as any);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockRoutingContract as any);

    // Mock deriveIsmConfig for the nested module
    sandbox.stub(evmIsmReader, 'deriveIsmConfig' as any).resolves({
      type: IsmType.TEST_ISM,
      address: mockModule,
    });

    const config = await evmIsmReader.deriveRoutingConfig(mockAddress);
    expect(config.type).to.equal(IsmType.INCREMENTAL_ROUTING);
  });

  /*
    Testing for more nested ism types can be done manually by reading from existing contracts onchain.
    Examples of nested ism types include:
    - Aggregation
    - Routing
    - Fallback Domain Routing
  */
});

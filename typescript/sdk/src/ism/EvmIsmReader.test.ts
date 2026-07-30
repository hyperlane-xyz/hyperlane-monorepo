import { expect } from 'chai';
import { BigNumber, constants } from 'ethers';
import sinon from 'sinon';

import {
  AbstractRoutingIsm__factory,
  AmountRoutingIsm,
  AmountRoutingIsm__factory,
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
import { WithAddress, addressToBytes32 } from '@hyperlane-xyz/utils';

import { TestChainName, test2 } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { missingSelectorError, networkError } from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import {
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

describe('EvmIsmReader', () => {
  let evmIsmReader: EvmIsmReader;
  let multiProvider: MultiProvider;
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
    evmIsmReader = new EvmIsmReader(multiProvider, TestChainName.test1);
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
      .stub(NetFlowRateLimitedHookIsm__factory, 'connect')
      .returns(mockContract as unknown as NetFlowRateLimitedHookIsm);
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
      maxDelay: sandbox.stub().rejects(missingSelectorError()),
      warpRouter: sandbox.stub().resolves(mockWarpRouter),
      thresholdBps: sandbox.stub().resolves(BigNumber.from(500)),
      DURATION: sandbox.stub().resolves(BigNumber.from(86400)),
      owner: sandbox.stub().resolves(mockOwner),
    };
    sandbox
      .stub(PausableIsm__factory, 'connect')
      .returns(mockContract as unknown as PausableIsm);
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(mockContract as unknown as TrustedRelayerIsm);
    sandbox
      .stub(OPStackIsm__factory, 'connect')
      .returns(mockContract as unknown as OPStackIsm);
    sandbox
      .stub(CCIPIsm__factory, 'connect')
      .returns(mockContract as unknown as CCIPIsm);
    sandbox
      .stub(RateLimitedIsm__factory, 'connect')
      .returns(mockContract as unknown as RateLimitedIsm);
    sandbox
      .stub(NetFlowRateLimitedHookIsm__factory, 'connect')
      .returns(mockContract as unknown as NetFlowRateLimitedHookIsm);
    sandbox
      .stub(DelayedFlowRouterHookIsm__factory, 'connect')
      .returns(mockContract as unknown as DelayedFlowRouterHookIsm);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);

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
      .returns(mockContract as unknown as PausableIsm);
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(mockContract as unknown as TrustedRelayerIsm);
    sandbox
      .stub(OPStackIsm__factory, 'connect')
      .returns(mockContract as unknown as OPStackIsm);
    sandbox
      .stub(CCIPIsm__factory, 'connect')
      .returns(mockContract as unknown as CCIPIsm);
    sandbox
      .stub(RateLimitedIsm__factory, 'connect')
      .returns(mockContract as unknown as RateLimitedIsm);
    sandbox
      .stub(NetFlowRateLimitedHookIsm__factory, 'connect')
      .returns(mockContract as unknown as NetFlowRateLimitedHookIsm);
    sandbox
      .stub(DelayedFlowRouterHookIsm__factory, 'connect')
      .returns(mockContract as unknown as DelayedFlowRouterHookIsm);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);

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
      .returns(mockContract as unknown as PausableIsm);
    sandbox
      .stub(TrustedRelayerIsm__factory, 'connect')
      .returns(mockContract as unknown as TrustedRelayerIsm);
    sandbox
      .stub(OPStackIsm__factory, 'connect')
      .returns(mockContract as unknown as OPStackIsm);
    sandbox
      .stub(CCIPIsm__factory, 'connect')
      .returns(mockContract as unknown as CCIPIsm);
    sandbox
      .stub(RateLimitedIsm__factory, 'connect')
      .returns(mockContract as unknown as RateLimitedIsm);
    sandbox
      .stub(NetFlowRateLimitedHookIsm__factory, 'connect')
      .returns(mockContract as unknown as NetFlowRateLimitedHookIsm);
    sandbox
      .stub(IInterchainSecurityModule__factory, 'connect')
      .returns(mockContract as unknown as IInterchainSecurityModule);

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

    sandbox.stub(AbstractRoutingIsm__factory, 'connect').returns({
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
    } as unknown as InterchainAccountRouter);
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns({
      CCIP_READ_ISM: sandbox.stub().rejects(missingSelectorError()),
      bytecodeHash: sandbox.stub().rejects(missingSelectorError()),
    } as unknown as InterchainAccountRouter);
    sandbox.stub(Ownable__factory, 'connect').returns({
      owner: sandbox.stub().rejects(missingSelectorError()),
    } as unknown as InterchainAccountRouter);
    sandbox.stub(AmountRoutingIsm__factory, 'connect').returns({
      lower: sandbox.stub().rejects(missingSelectorError()),
      upper: sandbox.stub().rejects(missingSelectorError()),
      threshold: sandbox.stub().rejects(missingSelectorError()),
    } as unknown as AmountRoutingIsm);
    sandbox.stub(DefaultIsm__factory, 'connect').returns({
      mailbox: sandbox.stub().resolves(mockMailbox),
    } as unknown as DefaultIsm);
    sandbox.stub(IInterchainSecurityModule__factory, 'connect').returns({
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
    } as unknown as IInterchainSecurityModule);

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

    sandbox.stub(AbstractRoutingIsm__factory, 'connect').returns({
      moduleType: sandbox.stub().resolves(ModuleType.ROUTING),
    } as unknown as InterchainAccountRouter);
    sandbox.stub(InterchainAccountRouter__factory, 'connect').returns({
      CCIP_READ_ISM: sandbox.stub().rejects(missingSelectorError()),
      bytecodeHash: sandbox.stub().rejects(missingSelectorError()),
    } as unknown as InterchainAccountRouter);
    sandbox.stub(Ownable__factory, 'connect').returns({
      owner: sandbox.stub().rejects(missingSelectorError()),
    } as unknown as InterchainAccountRouter);
    sandbox.stub(AmountRoutingIsm__factory, 'connect').returns({
      lower: sandbox.stub().rejects(missingSelectorError()),
      upper: sandbox.stub().rejects(missingSelectorError()),
      threshold: sandbox.stub().rejects(missingSelectorError()),
    } as unknown as AmountRoutingIsm);
    sandbox.stub(DefaultIsm__factory, 'connect').returns({
      mailbox: sandbox.stub().rejects(missingSelectorError()),
    } as unknown as DefaultIsm);

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

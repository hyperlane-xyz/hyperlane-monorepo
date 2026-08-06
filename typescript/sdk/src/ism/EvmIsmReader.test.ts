import { expect } from 'chai';
import { BigNumber } from 'ethers';
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
  DomainRoutingIsm__factory,
  IInterchainSecurityModule,
  IInterchainSecurityModule__factory,
  IMultisigIsm,
  IMultisigIsm__factory,
  IncrementalDomainRoutingIsm__factory,
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
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
import { WithAddress, assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  EvmEventLogsReader,
  EvmEventLogsSource,
} from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import { contractDouble } from '../test/contractDouble.js';
import { missingSelectorError, networkError } from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import {
  BlacklistIsmConfig,
  InterchainAccountRouterIsm,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
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
      blacklistedIds: sandbox.stub().rejects(missingSelectorError()),
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
    const getLogsByTopicWithSource = sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopicWithSource')
      .resolves({
        logs: [
          messageBlacklistedLog(firstId, 100, 0),
          messageBlacklistedLog(secondId, 120, 1),
          messageBlacklistedLog(firstId, 140, 0),
        ],
        source: EvmEventLogsSource.Explorer,
      });

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
    expect(getLogsByTopicWithSource.calledOnce).to.be.true;
    expect(getLogsByTopicWithSource.firstCall.args[0]).to.deep.equal({
      contractAddress: LEGACY_BLACKLIST_ADDRESS,
      eventTopic: MESSAGE_BLACKLISTED_TOPIC,
    });
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
    sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopicWithSource')
      .resolves({ logs: [], source: EvmEventLogsSource.Explorer });

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

  it('should omit blacklistedIds when the legacy blacklist logs cannot be read', async () => {
    const mockOwner = randomAddress();

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        values: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopicWithSource')
      .rejects(networkError());

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    expect(config).to.deep.equal({
      address: LEGACY_BLACKLIST_ADDRESS,
      type: IsmType.BLACKLIST,
      owner: mockOwner,
    });
    expect('blacklistedIds' in config).to.be.false;
  });

  it('should omit blacklistedIds when the legacy blacklist logs fill an explorer page', async () => {
    const mockOwner = randomAddress();

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        values: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    // Etherscan-like explorers return a capped page with a success status, so a
    // full page is indistinguishable from a truncated one.
    sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopicWithSource')
      .resolves({ logs: fullLogPage(), source: EvmEventLogsSource.Explorer });

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    expect(config).to.deep.equal({
      address: LEGACY_BLACKLIST_ADDRESS,
      type: IsmType.BLACKLIST,
      owner: mockOwner,
    });
    expect('blacklistedIds' in config).to.be.false;
  });

  it('should keep a full page of legacy blacklist logs read over RPC', async () => {
    const mockOwner = randomAddress();

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        values: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    // The RPC source walks the whole range in chunks, so the same volume that
    // an explorer cannot prove complete is complete here.
    const logs = fullLogPage();
    sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopicWithSource')
      .resolves({ logs, source: EvmEventLogsSource.Rpc });

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    assert(
      config.type === IsmType.BLACKLIST,
      'expected a blacklist ISM config',
    );
    expect(config.blacklistedIds).to.have.lengthOf(logs.length);
  });

  it('should omit blacklistedIds when the legacy blacklist address is not a contract', async () => {
    const mockOwner = randomAddress();

    stubProbesBeforeBlacklist(sandbox);
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        blacklistedIds: sandbox.stub().resolves(false),
        owner: sandbox.stub().resolves(mockOwner),
        values: sandbox.stub().rejects(missingSelectorError()),
      }),
    );
    sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopicWithSource')
      .rejects(
        new Error(
          `Address "${LEGACY_BLACKLIST_ADDRESS}" on chain "test1" is not a contract`,
        ),
      );

    const config = await evmIsmReader.deriveNullConfig(
      LEGACY_BLACKLIST_ADDRESS,
    );

    expect(config).to.deep.equal({
      address: LEGACY_BLACKLIST_ADDRESS,
      type: IsmType.BLACKLIST,
      owner: mockOwner,
    });
    expect('blacklistedIds' in config).to.be.false;
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
    const getLogsByTopicWithSource = sandbox.stub(
      EvmEventLogsReader.prototype,
      'getLogsByTopicWithSource',
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
    expect(getLogsByTopicWithSource.notCalled).to.be.true;
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
    const getLogsByTopicWithSource = sandbox.stub(
      EvmEventLogsReader.prototype,
      'getLogsByTopicWithSource',
    );

    let thrown: unknown;
    try {
      await evmIsmReader.deriveNullConfig(LEGACY_BLACKLIST_ADDRESS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
    expect(getLogsByTopicWithSource.notCalled).to.be.true;
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

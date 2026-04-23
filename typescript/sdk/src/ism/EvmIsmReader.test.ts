import { expect, vi } from 'vitest';
import { BigNumber } from 'ethers';

import {
  AbstractRoutingIsm__factory,
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
  TestIsm,
  TestIsm__factory,
  TrustedRelayerIsm,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import { WithAddress } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import {
  InterchainAccountRouterIsm,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  PausableIsmConfig,
  TestIsmConfig,
} from './types.js';

describe('EvmIsmReader', () => {
  let evmIsmReader: EvmIsmReader;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    multiProvider = MultiProvider.createTestMultiProvider();
    evmIsmReader = new EvmIsmReader(multiProvider, TestChainName.test1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should derive multisig config correctly', async () => {
    const mockAddress = randomAddress();
    const mockValidators = [randomAddress(), randomAddress()];
    const mockThreshold = 2;

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      moduleType: vi.fn().mockResolvedValue(ModuleType.MESSAGE_ID_MULTISIG),
      validatorsAndThreshold: vi
        .fn()
        .mockResolvedValue([mockValidators, mockThreshold]),
    };
    vi.spyOn(IMultisigIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as IMultisigIsm,
    );
    vi.spyOn(IInterchainSecurityModule__factory, 'connect').mockReturnValue(
      mockContract as unknown as IInterchainSecurityModule,
    );

    const expectedConfig: WithAddress<MultisigIsmConfig> = {
      address: mockAddress,
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: mockValidators,
      threshold: mockThreshold,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveMultisigConfig(mockAddress);
    expect(config).toEqual(ismConfig);
  });

  it('should derive pausable config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockPaused = true;

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      moduleType: vi.fn().mockResolvedValue(ModuleType.NULL),
      owner: vi.fn().mockResolvedValue(mockOwner),
      paused: vi.fn().mockResolvedValue(mockPaused),
    };
    vi.spyOn(PausableIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as PausableIsm,
    );
    vi.spyOn(TrustedRelayerIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as TrustedRelayerIsm,
    );
    vi.spyOn(IInterchainSecurityModule__factory, 'connect').mockReturnValue(
      mockContract as unknown as IInterchainSecurityModule,
    );

    const expectedConfig: WithAddress<PausableIsmConfig> = {
      address: mockAddress,
      owner: mockOwner,
      type: IsmType.PAUSABLE,
      paused: mockPaused,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveNullConfig(mockAddress);
    expect(config).toEqual(ismConfig);
  });

  it('should derive test ISM config correctly', async () => {
    const mockAddress = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      moduleType: vi.fn().mockResolvedValue(ModuleType.NULL),
    };
    vi.spyOn(TestIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as TestIsm,
    );
    vi.spyOn(OPStackIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as OPStackIsm,
    );
    vi.spyOn(PausableIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as PausableIsm,
    );
    vi.spyOn(TrustedRelayerIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as TrustedRelayerIsm,
    );
    vi.spyOn(CCIPIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as CCIPIsm,
    );
    vi.spyOn(IInterchainSecurityModule__factory, 'connect').mockReturnValue(
      mockContract as unknown as IInterchainSecurityModule,
    );

    const expectedConfig: WithAddress<TestIsmConfig> = {
      address: mockAddress,
      type: IsmType.TEST_ISM,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveNullConfig(mockAddress);
    expect(config).toEqual(ismConfig);
  });

  it('should derive the ICA ism correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockccipIsm = randomAddress();
    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      moduleType: vi.fn().mockResolvedValue(ModuleType.ROUTING),
      owner: vi.fn().mockResolvedValue(mockOwner),
      CCIP_READ_ISM: vi.fn().mockResolvedValue(mockccipIsm),
    };
    const mockDefaultFallbackContract = {
      moduleType: vi.fn().mockResolvedValue(ModuleType.ROUTING),
      owner: vi.fn().mockResolvedValue(mockOwner),
      domains: vi.fn().mockResolvedValue([]),
    };
    vi.spyOn(AbstractRoutingIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as InterchainAccountRouter,
    );
    vi.spyOn(InterchainAccountRouter__factory, 'connect').mockReturnValue(
      mockContract as unknown as InterchainAccountRouter,
    );
    vi.spyOn(TrustedRelayerIsm__factory, 'connect').mockReturnValue(
      mockContract as unknown as TrustedRelayerIsm,
    );
    vi.spyOn(IInterchainSecurityModule__factory, 'connect').mockReturnValue(
      mockContract as unknown as IInterchainSecurityModule,
    );
    vi.spyOn(Ownable__factory, 'connect').mockReturnValue(mockContract as any);
    vi.spyOn(DefaultFallbackRoutingIsm__factory, 'connect').mockReturnValue(
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
    expect(ismConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveRoutingConfig(mockAddress);
    expect(config).toEqual(ismConfig);
  });

  it('should derive incremental routing ISM config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockDomain = 1;
    const mockModule = randomAddress();

    // Mock the routing ISM contract
    const mockRoutingContract = {
      moduleType: vi.fn().mockResolvedValue(ModuleType.ROUTING),
      owner: vi.fn().mockResolvedValue(mockOwner),
      domains: vi.fn().mockResolvedValue([mockDomain]),
      module: vi.fn().mockResolvedValue(mockModule),
    };

    // Mock fallback routing to fail mailbox() call
    const mockFallbackContract = {
      mailbox: vi.fn().mockRejectedValue(new Error('No mailbox')),
      domains: vi.fn().mockResolvedValue([BigNumber.from(mockDomain)]),
      module: vi.fn().mockResolvedValue(mockModule),
    };

    const mockProvider = evmIsmReader['provider'];
    vi.spyOn(mockProvider, 'getCode').mockResolvedValue(
      IncrementalDomainRoutingIsm__factory.bytecode,
    );

    vi.spyOn(AbstractRoutingIsm__factory, 'connect').mockReturnValue(
      mockRoutingContract as any,
    );
    vi.spyOn(Ownable__factory, 'connect').mockReturnValue({
      owner: vi.fn().mockResolvedValue(mockOwner),
    } as any);
    vi.spyOn(DefaultFallbackRoutingIsm__factory, 'connect').mockReturnValue(
      mockFallbackContract as any,
    );
    vi.spyOn(DomainRoutingIsm__factory, 'connect').mockReturnValue(
      mockRoutingContract as any,
    );
    vi.spyOn(InterchainAccountRouter__factory, 'connect').mockReturnValue({
      CCIP_READ_ISM: vi.fn().mockRejectedValue(new Error('Not ICA')),
    } as any);
    vi.spyOn(IInterchainSecurityModule__factory, 'connect').mockReturnValue(
      mockRoutingContract as any,
    );

    // Mock deriveIsmConfig for the nested module
    vi.spyOn(evmIsmReader, 'deriveIsmConfig' as any).mockResolvedValue({
      type: IsmType.TEST_ISM,
      address: mockModule,
    });

    const config = await evmIsmReader.deriveRoutingConfig(mockAddress);
    expect(config.type).toBe(IsmType.INCREMENTAL_ROUTING);
  });

  /*
    Testing for more nested ism types can be done manually by reading from existing contracts onchain.
    Examples of nested ism types include:
    - Aggregation
    - Routing
    - Fallback Domain Routing
  */
});

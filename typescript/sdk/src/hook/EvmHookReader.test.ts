import { expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { randomBytes } from 'ethers/lib/utils.js';

import {
  CCIPHook,
  CCIPHook__factory,
  DefaultHook,
  DefaultHook__factory,
  IPostDispatchHook,
  IPostDispatchHook__factory,
  MerkleTreeHook,
  MerkleTreeHook__factory,
  OPStackHook,
  OPStackHook__factory,
  PausableHook,
  PausableHook__factory,
  ProtocolFee,
  ProtocolFee__factory,
} from '@hyperlane-xyz/core';
import { WithAddress } from '@hyperlane-xyz/utils';

import { TestChainName, test1 } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmHookReader } from './EvmHookReader.js';
import {
  CCIPHookConfig,
  HookType,
  MailboxDefaultHookConfig,
  MerkleTreeHookConfig,
  OnchainHookType,
  OpStackHookConfig,
  PausableHookConfig,
  ProtocolFeeHookConfig,
} from './types.js';

describe('EvmHookReader', () => {
  let evmHookReader: EvmHookReader;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    multiProvider = MultiProvider.createTestMultiProvider();
    evmHookReader = new EvmHookReader(multiProvider, TestChainName.test1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should derive merkle tree config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: vi.fn().mockResolvedValue(OnchainHookType.MERKLE_TREE),
      owner: vi.fn().mockResolvedValue(mockOwner),
    };
    vi.spyOn(MerkleTreeHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as MerkleTreeHook,
    );
    vi.spyOn(IPostDispatchHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as IPostDispatchHook,
    );

    const expectedConfig: WithAddress<MerkleTreeHookConfig> = {
      address: mockAddress,
      type: HookType.MERKLE_TREE,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.deriveMerkleTreeConfig(mockAddress);
    expect(config).toEqual(hookConfig);
  });

  it('should derive protocol fee hook correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockBeneficiary = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: vi.fn().mockResolvedValue(OnchainHookType.PROTOCOL_FEE),
      owner: vi.fn().mockResolvedValue(mockOwner),
      MAX_PROTOCOL_FEE: vi
        .fn()
        .mockResolvedValue(ethers.BigNumber.from('1000')),
      protocolFee: vi.fn().mockResolvedValue(ethers.BigNumber.from('10')),
      beneficiary: vi.fn().mockResolvedValue(mockBeneficiary),
    };
    vi.spyOn(ProtocolFee__factory, 'connect').mockReturnValue(
      mockContract as unknown as ProtocolFee,
    );
    vi.spyOn(IPostDispatchHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as IPostDispatchHook,
    );

    const expectedConfig: WithAddress<ProtocolFeeHookConfig> = {
      owner: mockOwner,
      address: mockAddress,
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: '1000',
      protocolFee: '10',
      beneficiary: mockBeneficiary,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.deriveProtocolFeeConfig(mockAddress);
    expect(config).toEqual(hookConfig);
  });

  it('should derive pausable config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockPaused = randomBytes(1)[0] % 2 === 0;

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: vi.fn().mockResolvedValue(OnchainHookType.PAUSABLE),
      owner: vi.fn().mockResolvedValue(mockOwner),
      paused: vi.fn().mockResolvedValue(mockPaused),
    };
    vi.spyOn(PausableHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as PausableHook,
    );
    vi.spyOn(IPostDispatchHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as IPostDispatchHook,
    );

    const expectedConfig: WithAddress<PausableHookConfig> = {
      owner: mockOwner,
      paused: mockPaused,
      address: mockAddress,
      type: HookType.PAUSABLE,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.derivePausableConfig(mockAddress);
    expect(config).toEqual(hookConfig);
  });

  it('should derive mailbox default hook config correctly', async () => {
    const mockAddress = randomAddress();
    const mockMailbox = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: vi.fn().mockResolvedValue(OnchainHookType.MAILBOX_DEFAULT_HOOK),
      mailbox: vi.fn().mockResolvedValue(mockMailbox),
    };
    vi.spyOn(DefaultHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as DefaultHook,
    );
    vi.spyOn(IPostDispatchHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as IPostDispatchHook,
    );

    const expectedConfig: WithAddress<MailboxDefaultHookConfig> = {
      address: mockAddress,
      type: HookType.MAILBOX_DEFAULT,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config =
      await evmHookReader.deriveMailboxDefaultHookConfig(mockAddress);
    expect(config).toEqual(hookConfig);
  });

  it('should derive op stack config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const l1Messenger = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: vi.fn().mockResolvedValue(OnchainHookType.ID_AUTH_ISM),
      owner: vi.fn().mockResolvedValue(mockOwner),
      l1Messenger: vi.fn().mockResolvedValue(l1Messenger),
      destinationDomain: vi.fn().mockResolvedValue(test1.domainId),
    };
    vi.spyOn(OPStackHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as OPStackHook,
    );
    vi.spyOn(IPostDispatchHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as IPostDispatchHook,
    );

    const expectedConfig: WithAddress<OpStackHookConfig> = {
      owner: mockOwner,
      address: mockAddress,
      type: HookType.OP_STACK,
      nativeBridge: l1Messenger,
      destinationChain: TestChainName.test1,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).toEqual(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.deriveOpStackConfig(mockAddress);
    expect(config).toEqual(hookConfig);
  });

  it('should derive CCIPHook configuration correctly', async () => {
    const ccipHookAddress = randomAddress();
    const destinationDomain = test1.domainId;
    const ism = randomAddress();

    // Mock the CCIPHook contract
    const mockContract = {
      hookType: vi.fn().mockResolvedValue(OnchainHookType.ID_AUTH_ISM),
      destinationDomain: vi.fn().mockResolvedValue(destinationDomain),
      ism: vi.fn().mockResolvedValue(ism),
    };

    vi.spyOn(CCIPHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as CCIPHook,
    );
    vi.spyOn(IPostDispatchHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as IPostDispatchHook,
    );

    const config = await evmHookReader.deriveCcipConfig(ccipHookAddress);

    const expectedConfig: WithAddress<CCIPHookConfig> = {
      address: ccipHookAddress,
      type: HookType.CCIP,
      destinationChain: TestChainName.test1,
    };

    expect(config).toEqual(expectedConfig);
  });

  it('should throw if derivation fails', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      // No type
      owner: vi.fn().mockResolvedValue(mockOwner),
    };
    vi.spyOn(MerkleTreeHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as MerkleTreeHook,
    );
    vi.spyOn(IPostDispatchHook__factory, 'connect').mockReturnValue(
      mockContract as unknown as IPostDispatchHook,
    );

    // top-level method infers hook type
    try {
      await evmHookReader.deriveHookConfig(mockAddress);
    } catch (e: any) {
      expect(e.toString()).toContain(
        `Failed to derive undefined hook (${mockAddress}):`,
      );
    }
  });

  /*
    Testing for more nested hook types can be done manually by reading from existing contracts onchain.
    Examples of nested hook types include:
    - Aggregation
    - Domain Routing
    - Fallback Domain Routing
    - Interchain Gas Paymaster
  */
});

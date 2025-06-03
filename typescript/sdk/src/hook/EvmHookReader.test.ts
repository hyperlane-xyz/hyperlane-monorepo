import { expect } from 'chai';
import { ethers } from 'ethers';
import { randomBytes } from 'ethers/lib/utils.js';
import sinon from 'sinon';

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
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
    evmHookReader = new EvmHookReader(multiProvider, TestChainName.test1);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should derive merkle tree config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: sandbox.stub().resolves(OnchainHookType.MERKLE_TREE),
      owner: sandbox.stub().resolves(mockOwner),
    };
    sandbox
      .stub(MerkleTreeHook__factory, 'connect')
      .returns(mockContract as unknown as MerkleTreeHook);
    sandbox
      .stub(IPostDispatchHook__factory, 'connect')
      .returns(mockContract as unknown as IPostDispatchHook);

    const expectedConfig: WithAddress<MerkleTreeHookConfig> = {
      address: mockAddress,
      type: HookType.MERKLE_TREE,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.deriveMerkleTreeConfig(mockAddress);
    expect(config).to.deep.equal(hookConfig);
  });

  it('should derive protocol fee hook correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockBeneficiary = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: sandbox.stub().resolves(OnchainHookType.PROTOCOL_FEE),
      owner: sandbox.stub().resolves(mockOwner),
      MAX_PROTOCOL_FEE: sandbox.stub().resolves(ethers.BigNumber.from('1000')),
      protocolFee: sandbox.stub().resolves(ethers.BigNumber.from('10')),
      beneficiary: sandbox.stub().resolves(mockBeneficiary),
    };
    sandbox
      .stub(ProtocolFee__factory, 'connect')
      .returns(mockContract as unknown as ProtocolFee);
    sandbox
      .stub(IPostDispatchHook__factory, 'connect')
      .returns(mockContract as unknown as IPostDispatchHook);

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
    expect(hookConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.deriveProtocolFeeConfig(mockAddress);
    expect(config).to.deep.equal(hookConfig);
  });

  it('should derive pausable config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const mockPaused = randomBytes(1)[0] % 2 === 0;

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: sandbox.stub().resolves(OnchainHookType.PAUSABLE),
      owner: sandbox.stub().resolves(mockOwner),
      paused: sandbox.stub().resolves(mockPaused),
    };
    sandbox
      .stub(PausableHook__factory, 'connect')
      .returns(mockContract as unknown as PausableHook);
    sandbox
      .stub(IPostDispatchHook__factory, 'connect')
      .returns(mockContract as unknown as IPostDispatchHook);

    const expectedConfig: WithAddress<PausableHookConfig> = {
      owner: mockOwner,
      paused: mockPaused,
      address: mockAddress,
      type: HookType.PAUSABLE,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.derivePausableConfig(mockAddress);
    expect(config).to.deep.equal(hookConfig);
  });

  it('should derive mailbox default hook config correctly', async () => {
    const mockAddress = randomAddress();
    const mockMailbox = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: sandbox.stub().resolves(OnchainHookType.MAILBOX_DEFAULT_HOOK),
      mailbox: sandbox.stub().resolves(mockMailbox),
    };
    sandbox
      .stub(DefaultHook__factory, 'connect')
      .returns(mockContract as unknown as DefaultHook);
    sandbox
      .stub(IPostDispatchHook__factory, 'connect')
      .returns(mockContract as unknown as IPostDispatchHook);

    const expectedConfig: WithAddress<MailboxDefaultHookConfig> = {
      address: mockAddress,
      type: HookType.MAILBOX_DEFAULT,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config =
      await evmHookReader.deriveMailboxDefaultHookConfig(mockAddress);
    expect(config).to.deep.equal(hookConfig);
  });

  it('should derive op stack config correctly', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();
    const l1Messenger = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: sandbox.stub().resolves(OnchainHookType.ID_AUTH_ISM),
      owner: sandbox.stub().resolves(mockOwner),
      l1Messenger: sandbox.stub().resolves(l1Messenger),
      destinationDomain: sandbox.stub().resolves(test1.domainId),
    };
    sandbox
      .stub(OPStackHook__factory, 'connect')
      .returns(mockContract as unknown as OPStackHook);
    sandbox
      .stub(IPostDispatchHook__factory, 'connect')
      .returns(mockContract as unknown as IPostDispatchHook);

    const expectedConfig: WithAddress<OpStackHookConfig> = {
      owner: mockOwner,
      address: mockAddress,
      type: HookType.OP_STACK,
      nativeBridge: l1Messenger,
      destinationChain: TestChainName.test1,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.deriveOpStackConfig(mockAddress);
    expect(config).to.deep.equal(hookConfig);
  });

  it('should derive CCIPHook configuration correctly', async () => {
    const ccipHookAddress = randomAddress();
    const destinationDomain = test1.domainId;
    const ism = randomAddress();

    // Mock the CCIPHook contract
    const mockContract = {
      hookType: sandbox.stub().resolves(OnchainHookType.ID_AUTH_ISM),
      destinationDomain: sandbox.stub().resolves(destinationDomain),
      ism: sandbox.stub().resolves(ism),
    };

    sandbox
      .stub(CCIPHook__factory, 'connect')
      .returns(mockContract as unknown as CCIPHook);
    sandbox
      .stub(IPostDispatchHook__factory, 'connect')
      .returns(mockContract as unknown as IPostDispatchHook);

    const config = await evmHookReader.deriveCcipConfig(ccipHookAddress);

    const expectedConfig: WithAddress<CCIPHookConfig> = {
      address: ccipHookAddress,
      type: HookType.CCIP,
      destinationChain: TestChainName.test1,
    };

    expect(config).to.deep.equal(expectedConfig);
  });

  it('should throw if derivation fails', async () => {
    const mockAddress = randomAddress();
    const mockOwner = randomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      // No type
      owner: sandbox.stub().resolves(mockOwner),
    };
    sandbox
      .stub(MerkleTreeHook__factory, 'connect')
      .returns(mockContract as unknown as MerkleTreeHook);
    sandbox
      .stub(IPostDispatchHook__factory, 'connect')
      .returns(mockContract as unknown as IPostDispatchHook);

    // top-level method infers hook type
    try {
      await evmHookReader.deriveHookConfig(mockAddress);
    } catch (e: any) {
      expect(e.toString()).to.contain(
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

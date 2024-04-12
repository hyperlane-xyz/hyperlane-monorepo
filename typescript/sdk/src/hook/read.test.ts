import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import {
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

import { chainMetadata } from '../consts/chainMetadata.js';
import { Chains } from '../consts/chains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmHookReader } from './read.js';
import {
  HookType,
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

  const generateRandomAddress = () => ethers.Wallet.createRandom().address;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = new MultiProvider();
    multiProvider.setProvider(Chains.ethereum, ethers.getDefaultProvider());
    evmHookReader = new EvmHookReader(multiProvider, Chains.ethereum);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should derive merkle tree config correctly', async () => {
    const mockAddress = generateRandomAddress();
    const mockOwner = generateRandomAddress();

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
    const mockAddress = generateRandomAddress();
    const mockOwner = generateRandomAddress();
    const mockBeneficiary = generateRandomAddress();

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
    const mockAddress = generateRandomAddress();
    const mockOwner = generateRandomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: sandbox.stub().resolves(OnchainHookType.PAUSABLE),
      owner: sandbox.stub().resolves(mockOwner),
    };
    sandbox
      .stub(PausableHook__factory, 'connect')
      .returns(mockContract as unknown as PausableHook);
    sandbox
      .stub(IPostDispatchHook__factory, 'connect')
      .returns(mockContract as unknown as IPostDispatchHook);

    const expectedConfig: WithAddress<PausableHookConfig> = {
      owner: mockOwner,
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

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  it('should derive op stack config correctly', async () => {
    const mockAddress = generateRandomAddress();
    const mockOwner = generateRandomAddress();
    const l1Messenger = generateRandomAddress();

    // Mocking the connect method + returned what we need from contract object
    const mockContract = {
      hookType: sandbox.stub().resolves(OnchainHookType.ID_AUTH_ISM),
      owner: sandbox.stub().resolves(mockOwner),
      l1Messenger: sandbox.stub().resolves(l1Messenger),
      destinationDomain: sandbox
        .stub()
        .resolves(chainMetadata.ethereum.domainId),
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
      destinationChain: Chains.ethereum,
    };

    // top-level method infers hook type
    const hookConfig = await evmHookReader.deriveHookConfig(mockAddress);
    expect(hookConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the hook type
    const config = await evmHookReader.deriveOpStackConfig(mockAddress);
    expect(config).to.deep.equal(hookConfig);
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

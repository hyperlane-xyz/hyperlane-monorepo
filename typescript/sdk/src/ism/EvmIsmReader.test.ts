import { expect } from 'chai';
import sinon from 'sinon';

import {
  AbstractRoutingIsm__factory,
  CCIPIsm,
  CCIPIsm__factory,
  IInterchainSecurityModule,
  IInterchainSecurityModule__factory,
  IMultisigIsm,
  IMultisigIsm__factory,
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  OPStackIsm,
  OPStackIsm__factory,
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
  IcaIsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
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

    const expectedConfig: WithAddress<IcaIsmConfig> = {
      address: mockAddress,
      type: IsmType.ICA,
    };

    // top-level method infers ism type
    const ismConfig = await evmIsmReader.deriveIsmConfig(mockAddress);
    expect(ismConfig).to.deep.equal(expectedConfig);

    // should get same result if we call the specific method for the ism type
    const config = await evmIsmReader.deriveRoutingConfig(mockAddress);
    expect(config).to.deep.equal(ismConfig);
  });

  /*
    Testing for more nested ism types can be done manually by reading from existing contracts onchain.
    Examples of nested ism types include:
    - Aggregation
    - Routing
    - Fallback Domain Routing
  */
});

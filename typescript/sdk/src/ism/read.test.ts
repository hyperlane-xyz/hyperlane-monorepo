import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import {
  IInterchainSecurityModule,
  IInterchainSecurityModule__factory,
  IMultisigIsm,
  IMultisigIsm__factory,
  OPStackIsm,
  OPStackIsm__factory,
  PausableIsm,
  PausableIsm__factory,
  TestIsm,
  TestIsm__factory,
} from '@hyperlane-xyz/core';
import { WithAddress } from '@hyperlane-xyz/utils';

import { Chains } from '../consts/chains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmIsmReader } from './read.js';
import {
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

  const generateRandomAddress = () => ethers.Wallet.createRandom().address;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = new MultiProvider();
    multiProvider.setProvider(Chains.ethereum, ethers.getDefaultProvider());
    evmIsmReader = new EvmIsmReader(multiProvider, Chains.ethereum);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should derive multisig config correctly', async () => {
    const mockAddress = generateRandomAddress();
    const mockValidators = [generateRandomAddress(), generateRandomAddress()];
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
    const mockAddress = generateRandomAddress();
    const mockOwner = generateRandomAddress();
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
    const mockAddress = generateRandomAddress();

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

  /*
    Testing for more nested ism types can be done manually by reading from existing contracts onchain.
    Examples of nested ism types include:
    - Aggregation
    - Routing
    - Fallback Domain Routing
  */
});

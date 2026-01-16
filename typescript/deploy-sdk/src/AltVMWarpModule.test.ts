import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import Sinon from 'sinon';

import {
  AltVM,
  MockSigner,
  ProtocolType,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DerivedWarpConfig,
  TokenType,
  WarpConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { AltVMWarpModule } from './AltVMWarpModule.js';

// Mock protocol type for testing (use a unique value to avoid collisions)
const TestProtocolType = 'test' as ProtocolType;

// Mock ISM artifact manager
const mockIsmArtifactManager = {
  readIsm: async () => ({
    artifactState: 'DEPLOYED',
    config: { type: AltVM.IsmType.TEST_ISM },
    deployed: { address: '0x1234' },
  }),
  createReader: () => ({
    read: async () => ({
      artifactState: 'DEPLOYED',
      config: { type: AltVM.IsmType.TEST_ISM },
      deployed: { address: '0x1234' },
    }),
  }),
  createWriter: (type: any, signer: any) => ({
    create: async (artifact: any) => {
      // Call the appropriate signer method based on ISM type
      let ismAddress: string;
      if (type === AltVM.IsmType.MESSAGE_ID_MULTISIG) {
        const result = await signer.createMessageIdMultisigIsm({
          validators: artifact.config.validators,
          threshold: artifact.config.threshold,
        });
        ismAddress = result.ismAddress;
      } else if (type === AltVM.IsmType.MERKLE_ROOT_MULTISIG) {
        const result = await signer.createMerkleRootMultisigIsm({
          validators: artifact.config.validators,
          threshold: artifact.config.threshold,
        });
        ismAddress = result.ismAddress;
      } else {
        throw new Error(`Unsupported ISM type: ${type}`);
      }

      return [
        {
          artifactState: 'DEPLOYED',
          config: artifact.config,
          deployed: { address: ismAddress },
        },
        [], // No receipts for mock
      ];
    },
    update: async () => [],
  }),
};

// Mock hook artifact manager
const mockHookArtifactManager = {
  readHook: async () => ({
    artifactState: 'deployed' as const,
    config: { type: AltVM.HookType.MERKLE_TREE },
    deployed: { address: '0x5678' },
  }),
  createReader: () => ({
    read: async () => ({
      artifactState: 'deployed' as const,
      config: { type: AltVM.HookType.MERKLE_TREE },
      deployed: { address: '0x5678' },
    }),
  }),
  createWriter: (_type: any, _signer: any) => ({
    create: async (artifact: any) => {
      const hookAddress = '0xHOOKADDRESS';
      return [
        {
          artifactState: 'deployed' as const,
          config: artifact.config,
          deployed: { address: hookAddress },
        },
        [],
      ];
    },
    read: async () => ({
      artifactState: 'deployed' as const,
      config: { type: AltVM.HookType.MERKLE_TREE },
      deployed: { address: '0x5678' },
    }),
    update: async () => [],
  }),
};

// Mock protocol provider
const mockProtocolProvider = {
  createProvider: async () => ({}),
  createSigner: async () => ({}),
  createSubmitter: async () => ({}),
  createIsmArtifactManager: () => mockIsmArtifactManager,
  createHookArtifactManager: () => mockHookArtifactManager,
  getMinGas: () => ({
    CORE_DEPLOY_GAS: 0n,
    ISM_DEPLOY_GAS: 0n,
    TOKEN_DEPLOY_GAS: 0n,
    HOOK_DEPLOY_GAS: 0n,
  }),
};

// Register mock protocol provider once
if (!hasProtocol(TestProtocolType)) {
  registerProtocol(TestProtocolType, () => mockProtocolProvider as any);
}

const TestChainName = {
  test1: 'test1',
} as const;

chai.use(chaiAsPromised);
const expect = chai.expect;

/*

TEST CASES - AltVMWarpModule tests

* no updates needed if the config is the same
* update ownership
* new remote router with invalid config
* new remote router
* multiple new remote routers
* remove existing remote router
* update existing router address
* update existing router gas
* remove and add remote router at the same time
* new ISM
* update existing ISM

*/

describe('AltVMWarpModule', () => {
  let signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  let warpModule: AltVMWarpModule;
  let chainLookup: ChainLookup;

  const tokenAddress =
    '0x726f757465725f61707000000000000000000000000000010000000000000000';

  const actualConfig: WarpConfig = {
    type: TokenType.collateral,
    owner: 'hyp1jq304cthpx0lwhpqzrdjrcza559ukyy3sc4dw5',
    mailbox:
      '0x68797065726c616e650000000000000000000000000000000000000000000000',
    token: 'uhyp',
    remoteRouters: {
      '1234': {
        address:
          '0x726f757465725f61707000000000000000000000000000010000000000000000',
      },
    },
    destinationGas: {
      '1234': '200000',
    },
  };

  let readStub: Sinon.SinonStub;

  beforeEach(async () => {
    signer = await MockSigner.connectWithSigner();

    Sinon.stub(signer, 'getSignerAddress').returns(actualConfig.owner);

    // Create mock chainLookup
    chainLookup = {
      getChainMetadata: () => ({
        name: TestChainName.test1,
        domainId: 1,
        protocol: TestProtocolType,
      }),
      getChainName: () => TestChainName.test1,
      getDomainId: () => 1,
      getKnownChainNames: () => [TestChainName.test1],
    } as any;

    warpModule = new AltVMWarpModule(chainLookup, signer, {
      chain: TestChainName.test1,
      config: actualConfig,
      addresses: {
        deployedTokenRoute: tokenAddress,
      },
    });

    readStub = Sinon.stub(warpModule, 'read').resolves(
      actualConfig as DerivedWarpConfig,
    );
  });

  it('no updates needed if the config is the same', async () => {
    // ARRANGE
    const expectedConfig = actualConfig;

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(0);
  });

  it('update ownership', async () => {
    // ARRANGE
    const newOwner = 'hyp1hvg7zsnrj6h29q9ss577mhrxa04rn94hv2cm2e';

    const expectedConfig = {
      ...actualConfig,
      owner: newOwner,
    };

    const updateOwner = Sinon.stub(
      signer,
      'getSetTokenOwnerTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(1);
    expect(updateTransactions[0].annotation).to.include(
      'Transferring ownership of',
    );
    expect(
      updateOwner.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        newOwner,
      }),
    ).to.be.true;
  });

  it('new remote router with invalid config', async () => {
    // ARRANGE
    const newRemoteRouter = {
      receiverDomainId: 4321,
      receiverAddress:
        '0x726f757465725f61707000000000000000000000000000020000000000000000',
      gas: '300000',
    };

    // only add new router to remote routers and not to destination gas
    const expectedConfig = {
      ...actualConfig,
      remoteRouters: {
        ...actualConfig.remoteRouters,
        [newRemoteRouter.receiverDomainId]: {
          address: newRemoteRouter.receiverAddress,
        },
      },
    };

    // ACT & ASSERT
    expect(warpModule.update(expectedConfig)).to.be.rejectedWith(Error);
  });

  it('new remote router', async () => {
    // ARRANGE
    const newRemoteRouter = {
      receiverDomainId: 4321,
      receiverAddress:
        '0x726f757465725f61707000000000000000000000000000020000000000000000',
      gas: '300000',
    };

    const expectedConfig = {
      ...actualConfig,
      remoteRouters: {
        ...actualConfig.remoteRouters,
        [newRemoteRouter.receiverDomainId]: {
          address: newRemoteRouter.receiverAddress,
        },
      },
      destinationGas: {
        ...actualConfig.destinationGas,
        [newRemoteRouter.receiverDomainId]: newRemoteRouter.gas,
      },
    };

    const enrollRouter = Sinon.stub(
      signer,
      'getEnrollRemoteRouterTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(1);
    expect(updateTransactions[0].annotation).to.include('Enrolling Router');
    expect(
      enrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        remoteRouter: newRemoteRouter,
      }),
    ).to.be.true;
  });

  it('multiple new remote routers', async () => {
    // ARRANGE
    const newRemoteRouter1 = {
      receiverDomainId: 4321,
      receiverAddress:
        '0x726f757465725f61707000000000000000000000000000020000000000000000',
      gas: '300000',
    };
    const newRemoteRouter2 = {
      receiverDomainId: 5321,
      receiverAddress:
        '0x726f757465725f61707000000000000000000000000000030000000000000000',
      gas: '400000',
    };

    const expectedConfig = {
      ...actualConfig,
      remoteRouters: {
        ...actualConfig.remoteRouters,
        [newRemoteRouter1.receiverDomainId]: {
          address: newRemoteRouter1.receiverAddress,
        },
        [newRemoteRouter2.receiverDomainId]: {
          address: newRemoteRouter2.receiverAddress,
        },
      },
      destinationGas: {
        ...actualConfig.destinationGas,
        [newRemoteRouter1.receiverDomainId]: newRemoteRouter1.gas,
        [newRemoteRouter2.receiverDomainId]: newRemoteRouter2.gas,
      },
    };

    const enrollRouter = Sinon.stub(
      signer,
      'getEnrollRemoteRouterTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(2);
    expect(updateTransactions[0].annotation).to.include('Enrolling Router');
    expect(updateTransactions[1].annotation).to.include('Enrolling Router');

    expect(
      enrollRouter.calledWith({
        signer: actualConfig.owner,
        tokenAddress,
        remoteRouter: newRemoteRouter1,
      }),
    ).to.be.true;

    expect(
      enrollRouter.calledWith({
        signer: actualConfig.owner,
        tokenAddress,
        remoteRouter: newRemoteRouter2,
      }),
    ).to.be.true;
  });

  it('remove existing remote router', async () => {
    // ARRANGE
    const expectedConfig = {
      ...actualConfig,
      remoteRouters: {},
      destinationGas: {},
    };

    const unenrollRouter = Sinon.stub(
      signer,
      'getUnenrollRemoteRouterTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(1);
    expect(updateTransactions[0].annotation).to.include('Unenrolling Router');
    expect(
      unenrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        receiverDomainId: 1234,
      }),
    ).to.be.true;
  });

  it('update existing router address', async () => {
    // ARRANGE
    const newAddress =
      '0x726f757465725f61707000000000000000000000000000020000000000000000';

    const expectedConfig = {
      ...actualConfig,
      remoteRouters: {
        '1234': {
          address: newAddress,
        },
      },
    };

    const enrollRouter = Sinon.stub(
      signer,
      'getEnrollRemoteRouterTransaction',
    ).resolves();
    const unenrollRouter = Sinon.stub(
      signer,
      'getUnenrollRemoteRouterTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(2);
    expect(updateTransactions[0].annotation).to.include('Unenrolling Router');
    expect(updateTransactions[1].annotation).to.include('Enrolling Router');

    expect(
      enrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        remoteRouter: {
          receiverDomainId: 1234,
          receiverAddress: newAddress,
          gas: '200000',
        },
      }),
    ).to.be.true;

    expect(
      unenrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        receiverDomainId: 1234,
      }),
    ).to.be.true;
  });

  it('update existing router gas', async () => {
    // ARRANGE
    const newGas = '300000';

    const expectedConfig = {
      ...actualConfig,
      destinationGas: {
        '1234': newGas,
      },
    };

    const enrollRouter = Sinon.stub(
      signer,
      'getEnrollRemoteRouterTransaction',
    ).resolves();
    const unenrollRouter = Sinon.stub(
      signer,
      'getUnenrollRemoteRouterTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(2);
    expect(updateTransactions[0].annotation).to.include('Unenrolling Router');
    expect(updateTransactions[1].annotation).to.include('Enrolling Router');

    expect(
      enrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        remoteRouter: {
          receiverDomainId: 1234,
          receiverAddress:
            '0x726f757465725f61707000000000000000000000000000010000000000000000',
          gas: newGas,
        },
      }),
    ).to.be.true;

    expect(
      unenrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        receiverDomainId: 1234,
      }),
    ).to.be.true;
  });

  it('remove and add remote router at the same time', async () => {
    // ARRANGE
    const expectedConfig = {
      ...actualConfig,
      remoteRouters: {
        '4321': {
          address:
            '0x726f757465725f61707000000000000000000000000000020000000000000000',
        },
      },
      destinationGas: {
        '4321': '300000',
      },
    };

    const enrollRouter = Sinon.stub(
      signer,
      'getEnrollRemoteRouterTransaction',
    ).resolves();
    const unenrollRouter = Sinon.stub(
      signer,
      'getUnenrollRemoteRouterTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(2);
    expect(updateTransactions[0].annotation).to.include('Unenrolling Router');
    expect(updateTransactions[1].annotation).to.include('Enrolling Router');

    expect(
      enrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        remoteRouter: {
          receiverDomainId: 4321,
          receiverAddress:
            '0x726f757465725f61707000000000000000000000000000020000000000000000',
          gas: '300000',
        },
      }),
    ).to.be.true;

    expect(
      unenrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        receiverDomainId: 1234,
      }),
    ).to.be.true;
  });

  it('new ISM', async () => {
    // ARRANGE
    const newIsmAddress =
      '0x726f757465725f69736d00000000000000000000000000050000000000000000';
    const newIsm = {
      type: 'messageIdMultisigIsm' as const,
      validators: ['0xe699ceCa237DD38e8f2Fa308D7d1a2BeCFC5493E'],
      threshold: 1,
    };

    const expectedConfig = {
      ...actualConfig,
      interchainSecurityModule: newIsm,
    };

    const createIsm = Sinon.stub(signer, 'createMessageIdMultisigIsm').resolves(
      {
        ismAddress: newIsmAddress,
      },
    );
    const updateIsm = Sinon.stub(
      signer,
      'getSetTokenIsmTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(1);
    expect(updateTransactions[0].annotation).to.include(
      'Setting ISM for Warp Route to',
    );
    expect(
      createIsm.calledOnceWith({
        validators: newIsm.validators,
        threshold: newIsm.threshold,
      }),
    ).to.be.true;
    expect(
      updateIsm.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        ismAddress: newIsmAddress,
      }),
    ).to.be.true;
  });

  it('update existing ISM', async () => {
    // ARRANGE
    const existingIsmAddress =
      '0x726f757465725f69736d00000000000000000000000000040000000000000000';
    const existingIsm = {
      type: 'messageIdMultisigIsm' as const,
      validators: ['0xe699ceCa237DD38e8f2Fa308D7d1a2BeCFC5493E'],
      threshold: 1,
      address: existingIsmAddress,
    };

    const newIsmAddress =
      '0x726f757465725f69736d00000000000000000000000000050000000000000000';
    const newIsm = {
      type: 'merkleRootMultisigIsm' as const,
      validators: ['0xe699ceCa237DD38e8f2Fa308D7d1a2BeCFC5493E'],
      threshold: 1,
    };

    readStub.restore();
    Sinon.stub(warpModule, 'read').resolves({
      ...actualConfig,
      token: tokenAddress,
      interchainSecurityModule: existingIsm,
    } as DerivedWarpConfig);

    const expectedConfig = {
      ...actualConfig,
      interchainSecurityModule: newIsm,
    };

    // Stub ISM reading methods
    Sinon.stub(signer, 'getIsmType').resolves('messageIdMultisigIsm' as any);
    Sinon.stub(signer, 'getMessageIdMultisigIsm').resolves({
      address: existingIsmAddress,
      validators: existingIsm.validators,
      threshold: existingIsm.threshold,
    });

    const createIsm = Sinon.stub(
      signer,
      'createMerkleRootMultisigIsm',
    ).resolves({
      ismAddress: newIsmAddress,
    });
    const updateIsm = Sinon.stub(
      signer,
      'getSetTokenIsmTransaction',
    ).resolves();

    // ACT
    const updateTransactions = await warpModule.update(expectedConfig);

    // ASSERT
    expect(updateTransactions).to.have.lengthOf(1);
    expect(updateTransactions[0].annotation).to.include(
      'Setting ISM for Warp Route to',
    );

    // Check createIsm was called once
    expect(createIsm.callCount).to.equal(1);
    const createIsmCall = createIsm.getCall(0);
    expect(createIsmCall.args[0].threshold).to.equal(newIsm.threshold);
    expect(createIsmCall.args[0].validators.length).to.equal(
      newIsm.validators.length,
    );
    expect(createIsmCall.args[0].validators[0].toLowerCase()).to.equal(
      newIsm.validators[0].toLowerCase(),
    );

    // Check updateIsm was called once
    expect(updateIsm.callCount).to.equal(1);
    const updateIsmCall = updateIsm.getCall(0);
    expect(updateIsmCall.args[0]).to.deep.equal({
      signer: actualConfig.owner,
      tokenAddress,
      ismAddress: newIsmAddress,
    });
  });
});

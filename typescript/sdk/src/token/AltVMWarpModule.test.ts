import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import Sinon from 'sinon';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import { TestChainName } from '../consts/testChains.js';
import { IsmType } from '../ism/types.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MockSigner } from '../test/AltVMMockSigner.js';

import { AltVMWarpModule } from './AltVMWarpModule.js';
import { TokenType } from './config.js';
import { DerivedTokenRouterConfig, HypTokenRouterConfig } from './types.js';

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
  let signer: AltVM.ISigner<any, any>;
  let warpModule: AltVMWarpModule<any>;

  const tokenAddress =
    '0x726f757465725f61707000000000000000000000000000010000000000000000';

  const multiProvider = MultiProtocolProvider.createTestMultiProtocolProvider<{
    mailbox?: string;
  }>();

  const actualConfig: HypTokenRouterConfig = {
    type: TokenType.collateral,
    owner: 'hyp1jq304cthpx0lwhpqzrdjrcza559ukyy3sc4dw5',
    mailbox:
      '0x68797065726c616e650000000000000000000000000000000000000000000000',
    name: 'TEST',
    symbol: 'TEST',
    decimals: 18,
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

    warpModule = new AltVMWarpModule(
      multiProvider,
      {
        chain: TestChainName.test1,
        config: actualConfig,
        addresses: {
          deployedTokenRoute: tokenAddress,
        },
      },
      signer,
    );

    readStub = Sinon.stub(warpModule, 'read').resolves(
      actualConfig as DerivedTokenRouterConfig,
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
      type: IsmType.MESSAGE_ID_MULTISIG,
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
    const updateTransactions = await warpModule.update(
      expectedConfig as HypTokenRouterConfig,
    );

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
    const existingIsm = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: ['0xe699ceCa237DD38e8f2Fa308D7d1a2BeCFC5493E'],
      threshold: 1,
    };

    const newIsmAddress =
      '0x726f757465725f69736d00000000000000000000000000050000000000000000';
    const newIsm = {
      type: IsmType.MERKLE_ROOT_MULTISIG,
      validators: ['0xe699ceCa237DD38e8f2Fa308D7d1a2BeCFC5493E'],
      threshold: 1,
    };

    readStub.restore();
    Sinon.stub(warpModule, 'read').resolves({
      ...actualConfig,
      interchainSecurityModule: existingIsm,
    } as DerivedTokenRouterConfig);

    const expectedConfig = {
      ...actualConfig,
      interchainSecurityModule: newIsm,
    };

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
    const updateTransactions = await warpModule.update(
      expectedConfig as HypTokenRouterConfig,
    );

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
});

import { expect } from 'chai';
import Sinon from 'sinon';

import { AltVM } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MockSigner } from '../test/AltVMMockSigner.js';

import { AltVMWarpModule } from './AltVMWarpModule.js';
import { TokenType } from './config.js';
import { DerivedTokenRouterConfig, HypTokenRouterConfig } from './types.js';

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

  beforeEach(async () => {
    signer = await MockSigner.connectWithSigner();

    Sinon.stub(signer, 'getSignerAddress').resolves(actualConfig.owner);

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

    Sinon.stub(warpModule, 'read').resolves(
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
    );
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
    );
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
    );
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
    );

    expect(
      unenrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        receiverDomainId: 1234,
      }),
    );
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
    );

    expect(
      unenrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        receiverDomainId: 1234,
      }),
    );
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
    );

    expect(
      unenrollRouter.calledOnceWith({
        signer: actualConfig.owner,
        tokenAddress,
        receiverDomainId: 1234,
      }),
    );
  });
});

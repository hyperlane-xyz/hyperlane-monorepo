import { expect } from 'chai';
import { ethers } from 'hardhat';

import { DomainRoutingIsm__factory } from '@hyperlane-xyz/core';
import { IsmConfig, IsmType, MultiProvider } from '@hyperlane-xyz/sdk';

import { DeployParams, executeDeploy } from '../deploy/core.js';

describe('readFallbackRoutingIsmConfig', () => {
  let multiProvider: MultiProvider;
  let deployParams: DeployParams;
  let artifacts: any;
  const ismConfig: IsmConfig = {
    type: IsmType.ROUTING,
    owner: '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
    domains: {
      anvil2: {
        type: IsmType.MESSAGE_ID_MULTISIG,
        threshold: 1,
        validators: ['0xa0ee7a142d267c1f36714e4a8f75612f20a79720'],
      },
    },
  };

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    deployParams = {
      chains: ['anvil1'],
      signer,
      multiProvider,
      artifacts: {},
      ismConfigs: { anvil1: ismConfig },
      multisigConfigs: {},
      outPath: '/tmp',
      skipConfirmation: true,
    };
    artifacts = await executeDeploy(deployParams);
  });

  it('deploys and right module for the origin specified', async () => {
    const ism = DomainRoutingIsm__factory.connect(
      artifacts.anvil1.interchainSecurityModule,
      multiProvider.getSigner('anvil1'),
    );

    const actualIsm = await ism.module(multiProvider.getChainId('anvil2'));
    expect(actualIsm).to.equal(
      (artifacts.anvil1.anvil2 as any).messageIdMultisigIsm,
    );
  }).timeout(25000);
});

import { expect } from 'chai';

import { DomainRoutingIsm__factory } from '@hyperlane-xyz/core';
import { IsmConfig, IsmType } from '@hyperlane-xyz/sdk';

import { getContextWithSigner } from '../context.js';
import { DeployParams, executeDeploy } from '../deploy/core.js';

describe('readFallbackRoutingIsmConfig', () => {
  let deployParams: DeployParams;
  const key =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const { multiProvider, signer } = getContextWithSigner(
    key,
    './examples/anvil-chains.yaml',
  );
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

  it('deploys and right module for the origin specified', async () => {
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
    const artifacts = await executeDeploy(deployParams);
    const ism = DomainRoutingIsm__factory.connect(
      artifacts.anvil1.interchainSecurityModule,
      multiProvider.getSigner('anvil1'),
    );

    const actualIsm = await ism.module(multiProvider.getChainId('anvil2'));
    expect(actualIsm).to.equal(
      (artifacts.anvil1.anvil2 as any).messageIdMultisigIsm,
    );
  }).timeout(250000);
});

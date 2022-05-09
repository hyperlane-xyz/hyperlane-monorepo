import { utils } from '@abacus-network/deploy';
import { AbacusCore } from '@abacus-network/sdk';
import '@nomiclabs/hardhat-ethers';
import { ethers } from 'hardhat';
import path from 'path';
import { YoDeployer } from '..';
import { testConfigs } from '../networks';

async function main() {
  const [signer] = await ethers.getSigners();
  const environment = 'test';
  const multiProvider = utils.getMultiProviderFromConfigAndSigner(
    testConfigs,
    signer,
  );
  const core = AbacusCore.fromEnvironment('test', multiProvider);

  const deployer = new YoDeployer(
    multiProvider,
    { owner: signer.address },
    core,
  );
  const addresses = await deployer.deploy();
  deployer.writeContracts(
    addresses,
    path.join('./src/sdk/environments/', environment + '.ts'),
  );
}

main().then(console.log).catch(console.error);

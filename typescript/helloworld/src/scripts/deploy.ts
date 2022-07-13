import '@nomiclabs/hardhat-ethers';
import { ethers } from 'hardhat';

import {
  AbacusCore,
  getChainToOwnerMap,
  getMultiProviderFromConfigAndSigner,
  serializeContracts,
} from '@abacus-network/sdk';

import { testConfigs } from '../deploy/config';
import { HelloWorldDeployer } from '../deploy/deploy';

async function main() {
  const [signer] = await ethers.getSigners();
  const multiProvider = getMultiProviderFromConfigAndSigner(
    testConfigs,
    signer,
  );

  const core = AbacusCore.fromEnvironment('test', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(testConfigs, signer.address),
  );

  const deployer = new HelloWorldDeployer(multiProvider, config, core);
  const chainToContracts = await deployer.deploy();
  const addresses = serializeContracts(chainToContracts);
  console.info('===Contract Addresses===');
  console.info(JSON.stringify(addresses));
}

main()
  .then(() => console.info('Deploy complete'))
  .catch(console.error);

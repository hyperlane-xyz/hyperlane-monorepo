import { utils } from '@abacus-network/deploy';
import { AbacusCore, serializeContracts } from '@abacus-network/sdk';
import '@nomiclabs/hardhat-ethers';
import { ethers } from 'hardhat';
import { getConfigMap, testConfigs } from '../deploy/config';
import { HelloWorldDeployer } from '../deploy/deploy';

async function main() {
  const [signer] = await ethers.getSigners();
  const multiProvider = utils.getMultiProviderFromConfigAndSigner(
    testConfigs,
    signer,
  );

  const core = AbacusCore.fromEnvironment('test', multiProvider);
  const config = core.extendWithConnectionManagers(
    getConfigMap(signer.address),
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

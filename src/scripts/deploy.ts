import { Wallet } from 'ethers';

import {
  HyperlaneCore,
  HyperlaneIgp,
  MultiProvider,
  createRouterConfigMap,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';

import { prodConfigs } from '../deploy/config';
import { HelloWorldDeployer } from '../deploy/deploy';

async function main() {
  console.info('Getting signer');
  const signer = new Wallet('SET KEY HERE OR CREATE YOUR OWN SIGNER');

  console.info('Preparing utilities');
  const multiProvider = new MultiProvider(prodConfigs);
  multiProvider.setSharedSigner(signer);

  const core = HyperlaneCore.fromEnvironment('testnet', multiProvider);
  const igp = HyperlaneIgp.fromEnvironment('testnet', multiProvider);
  const config = createRouterConfigMap(
    signer.address,
    core.contractsMap,
    igp.contractsMap,
  );

  const deployer = new HelloWorldDeployer(multiProvider, config, core);
  const chainToContracts = await deployer.deploy();
  const addresses = serializeContractsMap(chainToContracts);
  console.info('===Contract Addresses===');
  console.info(JSON.stringify(addresses));
}

main()
  .then(() => console.info('Deploy complete'))
  .catch(console.error);

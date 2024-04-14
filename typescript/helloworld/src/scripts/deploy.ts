import { Wallet } from 'ethers';

import {
  HyperlaneCore,
  MultiProvider,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';

import { prodConfigs } from '../deploy/config.js';
import { HelloWorldDeployer } from '../deploy/deploy.js';

async function main() {
  console.info('Getting signer');
  const signer = new Wallet('SET KEY HERE OR CREATE YOUR OWN SIGNER');

  console.info('Preparing utilities');
  const multiProvider = new MultiProvider(prodConfigs);
  multiProvider.setSharedSigner(signer);

  const core = HyperlaneCore.fromEnvironment('testnet', multiProvider);
  const config = core.getRouterConfig(signer.address);

  const deployer = new HelloWorldDeployer(multiProvider);
  const chainToContracts = await deployer.deploy(config);
  const addresses = serializeContractsMap(chainToContracts);
  console.info('===Contract Addresses===');
  console.info(JSON.stringify(addresses));
}

main()
  .then(() => console.info('Deploy complete'))
  .catch(console.error);

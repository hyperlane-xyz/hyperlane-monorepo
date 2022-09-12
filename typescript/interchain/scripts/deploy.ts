import { Wallet } from 'ethers';

import {
  AbacusCore,
  MultiProvider,
  chainConnectionConfigs,
  getChainToOwnerMap,
  objMap,
  serializeContracts,
} from '@abacus-network/sdk';

import { InterchainAccountDeployer } from '../src/deploy';

export const prodConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
  fuji: chainConnectionConfigs.fuji,
  bsctestnet: chainConnectionConfigs.bsctestnet,
};

async function main() {
  console.info('Getting signer');
  const signer = new Wallet('pkey');

  console.info('Preparing utilities');
  const chainProviders = objMap(prodConfigs, (_, config) => ({
    provider: config.provider,
    confirmations: config.confirmations,
    overrides: config.overrides,
    signer: new Wallet('pkey', config.provider),
  }));
  const multiProvider = new MultiProvider(chainProviders);

  const core = AbacusCore.fromEnvironment('testnet2', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(prodConfigs, signer.address),
  );

  const deployer = new InterchainAccountDeployer(multiProvider, config, core);
  const chainToContracts = await deployer.deploy();
  const addresses = serializeContracts(chainToContracts);
  console.info('===Contract Addresses===');
  console.info(JSON.stringify(addresses));
}

main()
  .then(() => console.info('Deploy complete'))
  .catch(console.error);

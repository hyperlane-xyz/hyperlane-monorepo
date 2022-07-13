import '@nomiclabs/hardhat-ethers';
import { ethers } from 'hardhat';

import { serializeContracts } from '../../../contracts';
import { AbacusCore } from '../../../core/AbacusCore';
import { getMultiProviderFromConfigAndSigner } from '../../../deploy/utils';
import { EnvSubsetDeployer, testConfigs } from '../app';

async function main() {
  const [signer] = await ethers.getSigners();
  const multiProvider = getMultiProviderFromConfigAndSigner(
    testConfigs,
    signer,
  );
  const core = AbacusCore.fromEnvironment('test', multiProvider);
  const config = core.extendWithConnectionClientConfig({
    test1: { owner: signer.address },
    test2: { owner: signer.address },
    test3: { owner: signer.address },
  });
  const deployer = new EnvSubsetDeployer(multiProvider, config, core);
  const chainToContracts = await deployer.deploy();
  const addresses = serializeContracts(chainToContracts);
  console.info('===Contract Addresses===');
  console.info(JSON.stringify(addresses));
}

main()
  .then(() => console.info('Deploy complete'))
  .catch(console.error);

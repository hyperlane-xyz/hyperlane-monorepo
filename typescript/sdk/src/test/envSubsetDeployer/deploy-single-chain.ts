import { Chains } from '../../consts/chains';
import { serializeContracts } from '../../contracts';
import { HyperlaneCore } from '../../core/HyperlaneCore';
import { HyperlaneIgp } from '../../gas/HyperlaneIgp';
import { MultiProvider } from '../../providers/MultiProvider';
import { createRouterConfigMap } from '../testUtils';

import { EnvSubsetDeployer } from './app';
import { getAlfajoresSigner } from './utils';

async function main() {
  const signer = getAlfajoresSigner();

  console.info('Preparing utilities');
  const multiProvider = new MultiProvider();
  multiProvider.setSigner(Chains.alfajores, signer);

  const core = HyperlaneCore.fromEnvironment('testnet', multiProvider);
  const igp = HyperlaneIgp.fromEnvironment('testnet', multiProvider);
  const config = createRouterConfigMap(
    signer.address,
    core.contractsMap,
    igp.contractsMap,
  );

  console.info('Starting deployment');
  const deployer = new EnvSubsetDeployer(multiProvider, config, core);
  const chainToContracts = await deployer.deploy();
  const addresses = serializeContracts(chainToContracts);
  console.info('===Contract Addresses===');
  console.info(JSON.stringify(addresses));
}

main()
  .then(() => console.info('Deploy complete'))
  .catch(console.error);

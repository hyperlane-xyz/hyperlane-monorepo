import { serializeContracts } from '../../contracts';
import { AbacusCore } from '../../core/AbacusCore';
import { getChainToOwnerMap } from '../../deploy/utils';
import { MultiProvider } from '../../providers/MultiProvider';

import { EnvSubsetDeployer, alfajoresChainConfig } from './app';
import { getAlfajoresSigner } from './utils';

async function main() {
  const signer = getAlfajoresSigner();

  console.info('Preparing utilities');
  const multiProvider = new MultiProvider({
    alfajores: {
      provider: signer.provider,
      confirmations: alfajoresChainConfig.alfajores.confirmations,
      overrides: alfajoresChainConfig.alfajores.overrides,
    },
  });

  const core = AbacusCore.fromEnvironment('testnet2', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(alfajoresChainConfig, signer.address),
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

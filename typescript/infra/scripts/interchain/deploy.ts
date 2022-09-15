import { Wallet } from 'ethers';
import path from 'path';

import {
  InterchainAccountContracts,
  InterchainAccountDeployer,
  interchainAccountFactories,
} from '@abacus-network/interchain-accounts';
import {
  AbacusCore,
  ChainMap,
  buildContracts,
  objMap,
  promiseObjAll,
  serializeContracts,
} from '@abacus-network/sdk';

import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { readJSON, writeJSON } from '../../src/utils/utils';
import { getConfiguration } from '../helloworld/utils';
import {
  getContext,
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

async function main() {
  const environment = await getEnvironment();
  const context = await getContext();
  const coreConfig = getCoreEnvironmentConfig(environment);
  // Always deploy from the abacus deployer
  const multiProvider = await coreConfig.getMultiProvider(
    Contexts.Abacus,
    KEY_ROLE_ENUM.Deployer,
  );
  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'interchain',
    context,
  );

  let contracts: ChainMap<any, InterchainAccountContracts> = {};
  try {
    const addresses = readJSON(dir, 'addresses.json');
    contracts = buildContracts(addresses, interchainAccountFactories) as any;
  } catch (e) {
    console.error(e);
  }

  // config gcp deployer key as owner
  const configMap = await getConfiguration(environment, multiProvider);

  // create fresh signer
  const signer = Wallet.createRandom();

  // per-network deployment cost
  const deploymentGas = 3_000_000; // larger than should be necessary

  await promiseObjAll(
    objMap(multiProvider.chainMap, async (_, dc) => {
      // fund signer on each network with gas * gasPrice
      const actual = await dc.provider.getBalance(signer.address);
      const gasPrice = await dc.provider.getGasPrice();
      const desired = gasPrice.mul(deploymentGas);
      const value = desired.sub(actual);
      if (value.gt(0)) {
        await dc.sendTransaction({
          to: signer.address,
          value,
        });
      }
    }),
  );

  // rotate signer to fresh key on all chains
  multiProvider.rotateSigner(signer);

  const deployer = new InterchainAccountDeployer(
    multiProvider,
    configMap,
    core,
  );

  try {
    contracts = await deployer.deploy(contracts);
  } catch (e) {
    console.error(e);
    contracts = deployer.deployedContracts as any;
  }
  writeJSON(dir, 'addresses.json', serializeContracts(contracts));
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

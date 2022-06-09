import path from 'path';

import {
  HelloWorldConfig,
  HelloWorldDeployer,
} from '@abacus-network/helloworld';
import {
  AbacusCore,
  objMap,
  promiseObjAll,
  serializeContracts,
} from '@abacus-network/sdk';

import { writeJSON } from '../src/utils/utils';

import { getCoreEnvironmentConfig, getEnvironmentDirectory } from './utils';

async function main() {
  const environment = 'testnet2';
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider);

  const signerMap = await promiseObjAll(
    multiProvider.map(async (_, dc) => dc.signer!),
  );
  const configMap = await promiseObjAll(
    objMap(signerMap, async (_, signer) => {
      const config: HelloWorldConfig = {
        owner: await signer.getAddress(),
      };
      return config;
    }),
  );

  const deployer = new HelloWorldDeployer(multiProvider, configMap, core);
  const contracts = await deployer.deploy();
  const dir = path.join(getEnvironmentDirectory(environment), 'helloworld');
  writeJSON(dir, 'addresses.json', serializeContracts(contracts));
}

main().then(console.log).catch(console.error);

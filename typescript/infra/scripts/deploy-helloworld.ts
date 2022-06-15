import path from 'path';

import { HelloWorldDeployer } from '@abacus-network/helloworld';
import {
  AbacusCore,
  objMap,
  promiseObjAll,
  serializeContracts,
} from '@abacus-network/sdk';

import addresses from '../config/environments/testnet2/helloworld/addresses.json';
import { CoreEnvironmentConfig } from '../src/config';
import { writeJSON } from '../src/utils/utils';

import { getCoreEnvironmentConfig, getEnvironmentDirectory } from './utils';

type Chains = keyof typeof addresses;

async function main() {
  const environment = 'testnet2';
  // TODO Fix need for cast here due to https://github.com/abacus-network/abacus-monorepo/pull/594/files#diff-40a12589668de942078f498e0ab0fda512e1eb7397189d6d286b590ae87c45d1R31
  const coreConfig = getCoreEnvironmentConfig(
    environment,
  ) as CoreEnvironmentConfig<Chains>;
  const multiProvider = await coreConfig.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider);

  const signerMap = await promiseObjAll(
    multiProvider.map(async (_, dc) => dc.signer!),
  );
  const ownerMap = await promiseObjAll(
    objMap(signerMap, async (_, signer) => {
      return {
        owner: await signer.getAddress(),
      };
    }),
  );
  const configMap = core.extendWithConnectionManagers(ownerMap);

  const deployer = new HelloWorldDeployer(multiProvider, configMap, core);
  const contracts = await deployer.deploy();
  const dir = path.join(getEnvironmentDirectory(environment), 'helloworld');
  writeJSON(dir, 'addresses.json', serializeContracts(contracts));
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

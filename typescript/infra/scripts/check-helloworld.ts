import { HelloWorldApp, HelloWorldChecker } from '@abacus-network/helloworld';
import {
  HelloWorldContracts,
  helloWorldFactories,
} from '@abacus-network/helloworld/dist/sdk/contracts';
import {
  AbacusCore,
  ChainMap,
  buildContracts,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';

import addresses from '../config/environments/testnet2/helloworld/addresses.json';
import { CoreEnvironmentConfig } from '../src/config';

import { getCoreEnvironmentConfig } from './utils';

type Chains = keyof typeof addresses;

async function main() {
  const environment = 'testnet2';
  // TODO Fix need for cast here due to https://github.com/abacus-network/abacus-monorepo/pull/594/files#diff-40a12589668de942078f498e0ab0fda512e1eb7397189d6d286b590ae87c45d1R31
  const coreConfig = getCoreEnvironmentConfig(
    environment,
  ) as CoreEnvironmentConfig<Chains>;
  const multiProvider = await coreConfig.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider);

  const contracts = buildContracts(addresses, helloWorldFactories) as ChainMap<
    Chains,
    HelloWorldContracts
  >;
  const app = new HelloWorldApp(contracts, multiProvider);

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
  const checker = new HelloWorldChecker(multiProvider, app, configMap);
  await checker.check();
  checker.expectEmpty();
}

main()
  .then(() => console.info('HelloWorld check complete'))
  .catch(console.error);

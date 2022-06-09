import {
  HelloWorldApp,
  HelloWorldChecker,
  HelloWorldConfig,
} from '@abacus-network/helloworld';
import {
  HelloWorldContracts,
  helloWorldFactories,
} from '@abacus-network/helloworld/dist/sdk/contracts';
import {
  ChainMap,
  buildContracts,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';

import addresses from '../config/environments/testnet2/helloworld/addresses.json';

import { getCoreEnvironmentConfig } from './utils';

async function main() {
  const environment = 'testnet2';
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();

  type Chains = keyof typeof addresses;
  const contracts = buildContracts(addresses, helloWorldFactories) as ChainMap<
    Chains,
    HelloWorldContracts
  >;
  const app = new HelloWorldApp(contracts, multiProvider);

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
  const checker = new HelloWorldChecker(multiProvider, app, configMap);
  await checker.check();
  checker.expectEmpty();
}

main().then().catch(console.error);

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

import addresses from '../helloworld.json';

import { getCoreEnvironmentConfig } from './utils';

async function main() {
  const environment = 'testnet2';
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();

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
  type Chains = keyof typeof addresses;
  const contracts = buildContracts(addresses, helloWorldFactories) as ChainMap<
    Chains,
    HelloWorldContracts
  >;
  const app = new HelloWorldApp(contracts, multiProvider);
  const checker = new HelloWorldChecker(multiProvider, app, configMap);
  await checker.check();
  checker.expectEmpty();
}

main().then(console.log).catch(console.error);

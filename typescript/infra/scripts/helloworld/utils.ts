import { HelloWorldApp, HelloWorldContracts } from '@abacus-network/helloworld';
import { helloWorldFactories } from '@abacus-network/helloworld/dist/sdk/contracts';
import {
  AbacusCore,
  ChainMap,
  ChainName,
  MultiProvider,
  buildContracts,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';

import { CoreEnvironmentConfig, DeployEnvironment } from '../../src/config';

export async function getConfiguration<Chain extends ChainName>(
  environment: DeployEnvironment,
  multiProvider: MultiProvider<Chain>,
): Promise<
  ChainMap<Chain, { owner: string; abacusConnectionManager: string }>
> {
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

  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);

  const configMap = core.extendWithConnectionManagers(ownerMap);
  // @ts-ignore
  return configMap;
}

export async function getApp<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
) {
  const contracts = buildContracts(
    coreConfig.helloWorldAddresses!,
    helloWorldFactories,
  ) as ChainMap<Chain, HelloWorldContracts>;
  const multiProvider = await coreConfig.getMultiProvider();
  const app = new HelloWorldApp(contracts, multiProvider as any);
  return app;
}

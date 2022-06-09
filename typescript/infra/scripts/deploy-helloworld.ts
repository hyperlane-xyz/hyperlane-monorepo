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

import { getCoreEnvironmentConfig } from './utils';

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
  console.log('===helloworld addresses===');
  console.log(serializeContracts(contracts));
  console.log('===helloworld verification===');
  console.log(JSON.stringify(deployer.verificationInputs));
}

main().then(console.log).catch(console.error);

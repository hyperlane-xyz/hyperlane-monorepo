import { Wallet } from 'ethers';
import path from 'path';

import {
  InterchainAccountContracts,
  InterchainAccountDeployer,
  interchainAccountFactories,
} from '@abacus-network/interchain';
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

  let partialContracts: ChainMap<any, InterchainAccountContracts>;
  try {
    const addresses = readJSON(dir, 'partial_addresses.json');
    partialContracts = buildContracts(
      addresses,
      interchainAccountFactories,
    ) as any;
  } catch (e) {
    partialContracts = {};
  }

  // config gcp deployer key as owner
  const configMap = await getConfiguration(environment, multiProvider);
  console.log(configMap);

  const skip = Object.keys(partialContracts).concat('mumbai');
  delete configMap['mumbai'];
  // skip.forEach((chain) => );

  // create fresh signer
  const signer = Wallet.createRandom();

  // per-network deployment cost
  const deploymentGas = 50_000_000; // larger than should be necessary

  await promiseObjAll(
    objMap(multiProvider.chainMap, async (chain, dc) => {
      if (skip.includes(chain)) return;

      const actual = await dc.provider.getBalance(signer.address);

      // recover lost funds back to deployer key
      // const deployer = await dc.signer!.getAddress();
      // const value = actual.mul(75).div(100);
      // console.log({chain, value});
      // await signer.connect(dc.provider).sendTransaction({
      //   to: deployer,
      //   value
      // });
      // const after = await dc.provider.getBalance(signer.address);
      // console.log({chain, after});

      // fund signer on each network with gas * gasPrice
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
    const contracts = await deployer.deploy(partialContracts);
    writeJSON(dir, 'addresses.json', serializeContracts(contracts));
    writeJSON(
      dir,
      'verification.json',
      JSON.stringify(deployer.verificationInputs),
    );
  } catch (e) {
    console.error(e);
    writeJSON(
      dir,
      'partial_addresses.json',
      serializeContracts(deployer.deployedContracts as any),
    );
  }
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

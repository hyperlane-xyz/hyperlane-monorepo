import { utils } from '@abacus-network/deploy';
import { buildContracts, ChainMap, ChainName } from '@abacus-network/sdk';
import { ethers } from 'hardhat';
import { HelloWorldChecker } from '../deploy/check';
import { getConfigMap, testConfigs } from '../deploy/config';
import { HelloWorldApp } from '../sdk/app';
import { HelloWorldContracts, helloWorldFactories } from '../sdk/contracts';
import testEnvironmentAddresses from '../sdk/environments/test.json';

async function check() {
  const [signer] = await ethers.getSigners();
  const multiProvider = utils.getMultiProviderFromConfigAndSigner(
    testConfigs,
    signer,
  );

  const contractsMap = buildContracts(
    testEnvironmentAddresses,
    helloWorldFactories,
  ) as ChainMap<ChainName, HelloWorldContracts>;

  const app = new HelloWorldApp(contractsMap, multiProvider);

  const helloWorldChecker = new HelloWorldChecker(
    multiProvider,
    app,
    getConfigMap(signer.address),
  );
  await helloWorldChecker.check();
  helloWorldChecker.expectEmpty();
}

check()
  .then(() => console.info('Check complete'))
  .catch(console.error);

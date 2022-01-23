import * as proxyUtils from './proxyUtils';
import { CoreDeploy } from './core/CoreDeploy';
import { writeDeployOutput } from './core';
import * as contracts from '@optics-xyz/ts-interface/dist/optics-core';
import { log, warn } from './utils';

/**
 * Deploys a Home implementation on the chain of the given deploy and updates
 * the deploy instance with the new contract.
 *
 * @param deploy - The deploy instance
 */
export async function deployHomeImplementation(deploy: CoreDeploy) {
  const isTestDeploy: boolean = deploy.test;
  if (isTestDeploy) warn('deploying test Home');
  const homeFactory = isTestDeploy
    ? contracts.TestHome__factory
    : contracts.Home__factory;
  const implementation = await proxyUtils.deployImplementation<contracts.Home>(
    'Home',
    deploy,
    new homeFactory(deploy.deployer),
    deploy.chain.domain
  );

  deploy.contracts.home = proxyUtils.overrideBeaconProxyImplementation<contracts.Home>(
    implementation,
    deploy,
    new homeFactory(deploy.deployer),
    deploy.contracts.home!
  );
}

/**
 * Deploys a Replica implementation on the chain of the given deploy and updates
 * the deploy instance with the new contracts.
 *
 * @param deploy - The deploy instance
 */
export async function deployReplicaImplementation(deploy: CoreDeploy) {
  const isTestDeploy: boolean = deploy.test;
  if (isTestDeploy) warn('deploying test Replica');
  const replicaFactory = isTestDeploy
    ? contracts.TestReplica__factory
    : contracts.Replica__factory;
  const implementation = await proxyUtils.deployImplementation<contracts.Replica>(
    'Replica',
    deploy,
    new replicaFactory(deploy.deployer),
    deploy.chain.domain,
    deploy.config.processGas,
    deploy.config.reserveGas,
  );

  for (const domain in deploy.contracts.replicas) {
    deploy.contracts.replicas[domain] = proxyUtils.overrideBeaconProxyImplementation<contracts.Replica>(
      implementation,
      deploy,
      new replicaFactory(deploy.deployer),
      deploy.contracts.replicas[domain]
    );
  }
}

/**
 * Deploy a new contract implementation to each chain in the deploys
 * array.
 *
 * @dev The first chain in the array will be the governing chain
 *
 * @param deploys - An array of chain deploys
 * @param deployImplementation - A function that deploys a new implementation
 */
export async function deployImplementations(dir: string, deploys: CoreDeploy[], deployImplementation: (d: CoreDeploy) => void) {
  if (deploys.length == 0) {
    throw new Error('Must pass at least one deploy config');
  }

  // there exists any chain marked test
  const isTestDeploy: boolean = deploys.filter((c) => c.test).length > 0;

  log(isTestDeploy, `Beginning ${deploys.length} Chain deploy process`);
  log(isTestDeploy, `Deploy env is ${deploys[0].config.environment}`);
  log(isTestDeploy, `${deploys[0].chain.name} is governing`);

  log(isTestDeploy, 'awaiting provider ready');
  await Promise.all([
    deploys.map(async (deploy) => {
      await deploy.ready();
    }),
  ]);
  log(isTestDeploy, 'done readying');

  // Do it sequentially
  for (const deploy of deploys) {
    await deployImplementation(deploy)
  }

  // write config outputs again, should write under a different dir
  if (!isTestDeploy) {
    writeDeployOutput(deploys, dir);
  }
}

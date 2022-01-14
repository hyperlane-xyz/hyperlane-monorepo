import * as ethers from 'ethers';
import { assert } from 'console';
import * as fs from 'fs';

import * as proxyUtils from './proxyUtils';
import { populateGovernanceTransaction } from './governance';
import { CoreDeploy } from './core/CoreDeploy';
import { writeDeployOutput } from './core';
import * as contracts from '@optics-xyz/ts-interface/dist/optics-core';
import { checkCoreDeploy } from './core/checks';

type Address = string;

function log(isTest: boolean, str: string) {
  if (!isTest) {
    console.log(str);
  }
}

function warn(text: string, padded: boolean = false) {
  if (padded) {
    const padding = '*'.repeat(text.length + 8);
    console.log(
      `
      ${padding}
      *** ${text.toUpperCase()} ***
      ${padding}
      `,
    );
  } else {
    console.log(`**** ${text.toUpperCase()} ****`);
  }
}

type ContractUpgrade = {
  domain: number;
  implementationAddress: Address;
  upgradeBeaconAddress: Address;
  ubc: contracts.UpgradeBeaconController;
};

export function populateGovernanceUpgrade(deploys: CoreDeploy[], upgrade: ContractUpgrade, governorRouter: proxyUtils.BeaconProxy<contracts.GovernanceRouter>): Promise<ethers.UnsignedTransaction> {
  const call = { 
    domain: upgrade.domain,
    contract: upgrade.ubc,
    functionStr: 'upgrade',
    functionArgs: [
      upgrade.upgradeBeaconAddress,
      upgrade.implementationAddress,
    ]
  };
  return populateGovernanceTransaction(deploys, call, governorRouter)
}

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

  // TODO: consider requiring an upgrade beacon and UBC to be deployed already
  // TODO: update verification info

  deploy.contracts.home = await proxyUtils.deployImplementation<contracts.Home>(
    'Home',
    deploy,
    new homeFactory(deploy.deployer),
    deploy.contracts.home,
    deploy.chain.domain,
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

  // TODO: consider requiring an upgrade beacon and UBC to be deployed already
  // TODO: update verification info
  for (const domain in deploy.contracts.replicas) {
    deploy.contracts.replicas[domain] = await proxyUtils.deployImplementation<contracts.Replica>(
      'Replica',
      deploy,
      new replicaFactory(deploy.deployer),
      deploy.contracts.replicas[domain],
      deploy.chain.domain,
      deploy.config.processGas,
      deploy.config.reserveGas,
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
export async function deployImplementations(deploys: CoreDeploy[], deployImplementation: (d: CoreDeploy) => void) {
  if (deploys.length == 0) {
    throw new Error('Must pass at least one deploy config');
  }

  // there exists any chain marked test
  const isTestDeploy: boolean = deploys.filter((c) => c.test).length > 0;

  log(isTestDeploy, `Beginning ${deploys.length} Chain deploy process`);
  log(isTestDeploy, `Deploy env is ${deploys[0].config.environment}`);
  log(isTestDeploy, `${deploys[0].chain.name} is governing`);

  const govChain = deploys[0];
  const nonGovChains = deploys.slice(1);

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
    writeDeployOutput(deploys);
  }
}

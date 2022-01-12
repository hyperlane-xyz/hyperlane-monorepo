import * as ethers from 'ethers';
import { assert } from 'console';
import fs from 'fs';

import * as proxyUtils from '../proxyUtils';
import { CoreDeploy } from './CoreDeploy';
import * as contracts from '@optics-xyz/ts-interface/dist/optics-core';
import { checkCoreDeploy } from './checks';
import { toBytes32 } from '../utils';

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

type ContractCall = {
  domain: number;
  contract: types.Contract;
  functionStr: string;
  functionArgs: any[];
}

type GovernanceMessageCall = {
  to: Address;
  // DataHexString?
  data: string;
}

// TODO: Dedup with typescript/optics-tests/test/cross-chain/utils.ts
export async function toGovernanceMessageCall(call: ContractCall): Promise<GovernanceMessageCall> {
  // Set up data for call message
  const callFunc = call.contract.interface.getFunction(call.functionStr);
  const callDataEncoded = call.contract.interface.encodeFunctionData(
    callFunc,
    call.functionArgs,
  );

  return {
    to: contract.address,
    data: callDataEncoded,
  };
}

/**
 * Deploys a new home implementation on the chain of the given deploy, updates the deploy instance
 * with the new contract, and writes the data needed to upgrade to that implementation to a file.
 *
 * @param deploy - The deploy instance
 */
export async function upgradeHome(deploy: CoreDeploy) {
  const isTestDeploy: boolean = deploy.test;
  if (isTestDeploy) warn('deploying test Home');
  const homeFactory = isTestDeploy
    ? contracts.TestHome__factory
    : contracts.Home__factory;

  // TODO: consider requiring an upgrade beacon and UBC to be deployed already 

  deploy.contracts.home = await proxyUtils.deployImplementation<contracts.Home>(
    'Home',
    deploy,
    new homeFactory(deploy.deployer),
    deploy.contracts.home,
    deploy.chain.domain,
  );
}

export async function populateGovernanceTransaction(deploys: CoreDeploy[], call: ContractCall, governorRouter: BeaconProxy<contracts.GovernanceRouter>): Promise<UnsignedTx> {
  const message = await toGovernanceMessageCall(call)
  // Check if the upgrade is happening on the governor chain.
  const deploy = deploys.filter((x: CoreDeploy) => x.chain.domain === call.domain)[0]
  if (deploy.governor) {
    return governorRouter.populateTransaction.callLocal([message]);
  } else {
    return governorRouter.populateTransaction.callRemote(call.domain, [message]);
  }
}

export function populateGovernanceUpgrade(deploys: CoreDeploy[], upgrade: Upgrade, governorRouter: BeaconProxy<contracts.GovernanceRouter>): Promise<UnsignedTx> {
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

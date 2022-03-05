/*
import { assert } from 'console';
import { ethers } from 'ethers';
import fs from 'fs';

import * as proxyUtils from '../utils/proxy';
import { CoreDeploy } from './CoreDeploy';
import { core, xapps } from '@abacus-network/ts-interface';
import { CoreInvariantChecker } from './checks';
import { log, warn, toBytes32 } from '../utils/utils';

export async function deployGovernanceRouter(deploy: CoreDeploy) {
  const governanceRouter = xapps.GovernanceRouter__factory;

  let { xAppConnectionManager } = deploy.contracts;
  const recoveryTimelock = deploy.config.recoveryTimelock;

  let initData = governanceRouter
    .createInterface()
    .encodeFunctionData('initialize', [xAppConnectionManager!.address]);

  deploy.contracts.governanceRouter =
    await proxyUtils.deployProxy<xapps.GovernanceRouter>(
      'Governance',
      deploy,
      new governanceRouter(deploy.signer),
      initData,
      recoveryTimelock,
    );
}

export async function relinquish(deploy: CoreDeploy) {
  const isTestDeploy = deploy.test;
  const govRouter = await deploy.contracts.governanceRouter!.proxy.address;

  log(isTestDeploy, `${deploy.chain.name}: Relinquishing control`);
  await deploy.contracts.validatorManager!.transferOwnership(
    govRouter,
    deploy.overrides,
  );

  log(
    isTestDeploy,
    `${deploy.chain.name}: Dispatched relinquish validatormanager`,
  );

  await deploy.contracts.xAppConnectionManager!.transferOwnership(
    govRouter,
    deploy.overrides,
  );

  log(
    isTestDeploy,
    `${deploy.chain.name}: Dispatched relinquish XAppConnectionManager`,
  );

  await deploy.contracts.upgradeBeaconController!.transferOwnership(
    govRouter,
    deploy.overrides,
  );

  log(
    isTestDeploy,
    `${deploy.chain.name}: Dispatched relinquish upgradeBeaconController`,
  );

  Object.entries(deploy.contracts.inboxes).forEach(async ([domain, inbox]) => {
    await inbox.proxy.transferOwnership(govRouter, deploy.overrides);
    log(
      isTestDeploy,
      `${deploy.chain.name}: Dispatched relinquish Inbox for domain ${domain}`,
    );
  });

  let tx = await deploy.contracts.outbox!.proxy.transferOwnership(
    govRouter,
    deploy.overrides,
  );

  log(isTestDeploy, `${deploy.chain.name}: Dispatched relinquish outbox`);

  await tx.wait(deploy.chain.confirmations);
  log(isTestDeploy, `${deploy.chain.name}: Control relinquished`);
}

export function writePartials(dir: string) {
  // make folder if it doesn't exist already
  fs.mkdirSync(dir, { recursive: true });
  const defaultDir = '../../rust/config/default';
  const partialNames = ['kathy', 'processor', 'relayer', 'validator'];
  // copy partial config from default directory to given directory
  for (let partialName of partialNames) {
    const filename = `${partialName}-partial.json`;
    fs.copyFile(`${defaultDir}/${filename}`, `${dir}/${filename}`, (err) => {
      if (err) {
        console.error(err);
      }
    });
  }
}
export function writeRustConfigs(deploys: CoreDeploy[], writeDir?: string) {
  log(deploys[0].test, `Have ${deploys.length} deploys`);
  const dir = writeDir ? writeDir : `../../rust/config/${Date.now()}`;
  for (const local of deploys) {
    // get remotes
    const remotes = deploys
      .slice()
      .filter((remote) => remote.chain.domain !== local.chain.domain);

    const rustConfig = CoreDeploy.buildRustConfig(local, remotes);
    const name = local.chain.name;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      `${dir}/${name}_config.json`,
      JSON.stringify(rustConfig, null, 2),
    );
  }
  writePartials(dir);
}*/

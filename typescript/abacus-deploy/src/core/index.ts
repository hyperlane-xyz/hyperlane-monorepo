import { assert } from 'console';
import fs from 'fs';

import * as proxyUtils from '../utils/proxy';
import { CoreDeploy } from './CoreDeploy';
import * as contracts from '@abacus-network/ts-interface/dist/abacus-core';
import { CoreInvariantChecker } from './checks';
import { log, warn, toBytes32 } from '../utils/utils';

const nullRoot: string = '0x' + '00'.repeat(32);
export async function deployUpgradeBeaconController(deploy: CoreDeploy) {
  let factory = new contracts.UpgradeBeaconController__factory(deploy.signer);
  deploy.contracts.upgradeBeaconController = await factory.deploy(
    deploy.overrides,
  );
  assert(deploy.contracts.upgradeBeaconController);
  await deploy.contracts.upgradeBeaconController.deployTransaction.wait(
    deploy.chain.confirmations,
  );

  // add contract information to Etherscan verification array
  deploy.verificationInput.push({
    name: 'UpgradeBeaconController',
    address: deploy.contracts.upgradeBeaconController.address,
    constructorArguments: [],
  });
}

/**
 * Deploys the ValidatorManager on the chain of the given deploy and updates
 * the deploy instance with the new contract.
 *
 * @param deploy - The deploy instance
 */
export async function deployValidatorManager(deploy: CoreDeploy) {
  let factory = new contracts.ValidatorManager__factory(deploy.signer);
  deploy.contracts.validatorManager = await factory.deploy(deploy.overrides);
  await deploy.contracts.validatorManager.deployTransaction.wait(
    deploy.chain.confirmations,
  );

  // add contract information to Etherscan verification array
  deploy.verificationInput.push({
    name: 'ValidatorManager',
    address: deploy.contracts.validatorManager!.address,
    constructorArguments: [deploy.validator],
  });
}

/**
 * Deploys the XAppConnectionManager on the chain of the given deploy and updates
 * the deploy instance with the new contract.
 *
 * @param deploy - The deploy instance
 */
export async function deployXAppConnectionManager(deploy: CoreDeploy) {
  const signer = deploy.signer;
  const factory = new contracts.XAppConnectionManager__factory(signer);

  deploy.contracts.xAppConnectionManager = await factory.deploy(
    deploy.overrides,
  );
  await deploy.contracts.xAppConnectionManager.deployTransaction.wait(
    deploy.chain.confirmations,
  );

  // add contract information to Etherscan verification array
  deploy.verificationInput.push({
    name: 'XAppConnectionManager',
    address: deploy.contracts.xAppConnectionManager!.address,
    constructorArguments: [],
  });
}

/**
 * Deploys the Outbox proxy on the chain of the given deploy and updates
 * the deploy instance with the new contract.
 *
 * @param deploy - The deploy instance
 */
export async function deployOutbox(deploy: CoreDeploy) {
  const isTestDeploy: boolean = deploy.test;
  if (isTestDeploy) warn('deploying test Outbox');
  const outboxFactory = isTestDeploy
    ? contracts.TestOutbox__factory
    : contracts.Outbox__factory;

  let { validatorManager } = deploy.contracts;
  let initData = outboxFactory
    .createInterface()
    .encodeFunctionData('initialize', [validatorManager!.address]);

  deploy.contracts.outbox = await proxyUtils.deployProxy<contracts.Outbox>(
    'Outbox',
    deploy,
    new outboxFactory(deploy.signer),
    initData,
    deploy.chain.domain,
  );
}

/**
 * Deploys the GovernanceRouter proxy on the chain of the given deploy and updates
 * the deploy instance with the new contract.
 *
 * @param deploy - The deploy instance
 */
export async function deployGovernanceRouter(deploy: CoreDeploy) {
  const isTestDeploy: boolean = deploy.test;
  if (isTestDeploy) warn('deploying test GovernanceRouter');
  const governanceRouter = isTestDeploy
    ? contracts.TestGovernanceRouter__factory
    : contracts.GovernanceRouter__factory;

  let { xAppConnectionManager } = deploy.contracts;
  const recoveryTimelock = deploy.config.recoveryTimelock;

  let initData = governanceRouter
    .createInterface()
    .encodeFunctionData('initialize', [
      xAppConnectionManager!.address,
      deploy.recoveryManager,
    ]);

  deploy.contracts.governanceRouter =
    await proxyUtils.deployProxy<contracts.GovernanceRouter>(
      'Governance',
      deploy,
      new governanceRouter(deploy.signer),
      initData,
      deploy.chain.domain,
      recoveryTimelock,
    );
}

/**
 * Deploys an unenrolled Inbox proxy on the local chain and updates the local
 * deploy instance with the new contract.
 *
 * @param local - The local deploy instance
 * @param remote - The remote deploy instance
 */
export async function deployUnenrolledInbox(
  local: CoreDeploy,
  remote: CoreDeploy,
) {
  const isTestDeploy: boolean = remote.test;
  if (isTestDeploy) warn('deploying test Inbox');

  const inbox = isTestDeploy
    ? contracts.TestInbox__factory
    : contracts.Inbox__factory;

  let initData = inbox
    .createInterface()
    .encodeFunctionData('initialize', [
      remote.chain.domain,
      local.contracts.validatorManager!.address,
      nullRoot,
      0,
    ]);

  // if we have no inboxs, deploy the whole setup.
  // otherwise just deploy a fresh proxy
  let proxy;
  if (Object.keys(local.contracts.inboxs).length === 0) {
    log(
      isTestDeploy,
      `${local.chain.name}: deploying initial Inbox for ${remote.chain.name}`,
    );
    proxy = await proxyUtils.deployProxy<contracts.Inbox>(
      'Inbox',
      local,
      new inbox(local.signer),
      initData,
      local.chain.domain,
      local.config.processGas,
      local.config.reserveGas,
    );
  } else {
    log(
      isTestDeploy,
      `${local.chain.name}: deploying additional Inbox for ${remote.chain.name}`,
    );
    const prev = Object.entries(local.contracts.inboxs)[0][1];
    proxy = await proxyUtils.duplicate<contracts.Inbox>(
      'Inbox',
      local,
      prev,
      initData,
    );
  }
  local.contracts.inboxs[remote.chain.domain] = proxy;
  log(
    isTestDeploy,
    `${local.chain.name}: inbox deployed for ${remote.chain.name}`,
  );
}

/**
 * Deploys the entire abacus suite of contracts on the chain of the given deploy
 * and updates the deploy instance with the new contracts.
 *
 * @param deploy - The deploy instance
 */
export async function deployAbacus(deploy: CoreDeploy) {
  const isTestDeploy: boolean = deploy.test;
  if (isTestDeploy) {
    warn('deploying test contracts', true);
  }

  log(isTestDeploy, `${deploy.chain.name}: awaiting deploy UBC(deploy);`);
  await deployUpgradeBeaconController(deploy);

  log(
    isTestDeploy,
    `${deploy.chain.name}: awaiting deploy ValidatorManager(deploy);`,
  );
  await deployValidatorManager(deploy);

  log(
    isTestDeploy,
    `${deploy.chain.name}: awaiting deploy XappConnectionManager(deploy);`,
  );
  await deployXAppConnectionManager(deploy);

  log(isTestDeploy, `${deploy.chain.name}: awaiting deploy Outbox(deploy);`);
  await deployOutbox(deploy);

  log(
    isTestDeploy,
    `${deploy.chain.name}: awaiting XAppConnectionManager.setOutbox(...);`,
  );
  await deploy.contracts.xAppConnectionManager!.setOutbox(
    deploy.contracts.outbox!.proxy.address,
    deploy.overrides,
  );

  log(
    isTestDeploy,
    `${deploy.chain.name}: awaiting validatorManager.setValidator(...);`,
  );
  await deploy.contracts.validatorManager!.setValidator(
    deploy.chain.domain,
    deploy.validator,
    deploy.overrides,
  );

  log(
    isTestDeploy,
    `${deploy.chain.name}: awaiting deploy GovernanceRouter(deploy);`,
  );
  await deployGovernanceRouter(deploy);

  log(isTestDeploy, `${deploy.chain.name}: initial chain deploy completed`);
}

/**
 * Transfers ownership to the GovernanceRouter.
 *
 * @param deploy - The deploy instance
 */
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

  Object.entries(deploy.contracts.inboxs).forEach(async ([domain, inbox]) => {
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

/**
 * Enrolls a remote inbox on the local chain.
 *
 * @param local - The local deploy instance
 * @param remote - The remote deploy instance
 */
export async function enrollInbox(local: CoreDeploy, remote: CoreDeploy) {
  const isTestDeploy = local.test;
  log(isTestDeploy, `${local.chain.name}: starting inbox enrollment`);

  let tx = await local.contracts.xAppConnectionManager!.enrollInbox(
    local.contracts.inboxs[remote.chain.domain].proxy.address,
    remote.chain.domain,
    local.overrides,
  );
  await tx.wait(local.chain.confirmations);

  log(isTestDeploy, `${local.chain.name}: inbox enrollment done`);
}

/**
 * Enrolls a remote GovernanceRouter on the local chain.
 *
 * @param local - The local deploy instance
 * @param remote - The remote deploy instance
 */
export async function enrollGovernanceRouter(
  local: CoreDeploy,
  remote: CoreDeploy,
) {
  const isTestDeploy = local.test;
  log(
    isTestDeploy,
    `${local.chain.name}: starting enroll ${remote.chain.name} governance router`,
  );
  let tx = await local.contracts.governanceRouter!.proxy.setRouter(
    remote.chain.domain,
    toBytes32(remote.contracts.governanceRouter!.proxy.address),
    local.overrides,
  );
  await tx.wait(local.chain.confirmations);
  log(
    isTestDeploy,
    `${local.chain.name}: enrolled ${remote.chain.name} governance router`,
  );
}

/**
 * Enrolls a remote validator on the local chain.
 *
 * @param local - The local deploy instance
 * @param remote - The remote deploy instance
 */
export async function enrollValidator(local: CoreDeploy, remote: CoreDeploy) {
  const isTestDeploy = local.test;
  log(isTestDeploy, `${local.chain.name}: starting validator enrollment`);

  let tx = await local.contracts.validatorManager!.setValidator(
    remote.chain.domain,
    remote.validator,
    local.overrides,
  );
  await tx.wait(local.chain.confirmations);

  log(isTestDeploy, `${local.chain.name}: validator enrollment done`);
}

/**
 * Enrolls a remote Inbox, GovernanceRouter and Watchers on the local chain.
 *
 * @param local - The local deploy instance
 * @param remote - The remote deploy instance
 */
export async function enrollRemote(local: CoreDeploy, remote: CoreDeploy) {
  await deployUnenrolledInbox(local, remote);
  await enrollInbox(local, remote);
  await enrollGovernanceRouter(local, remote);
  await enrollValidator(local, remote);
}

/**
 * Transfers governorship to the governing chain's GovernanceRouter.
 *
 * @param gov - The governor chain deploy instance
 * @param non - The non-governor chain deploy instance
 */
export async function transferGovernorship(gov: CoreDeploy, non: CoreDeploy) {
  log(gov.test, `${non.chain.name}: transferring governorship`);
  let governorAddress = await gov.contracts.governanceRouter!.proxy.governor();
  let tx = await non.contracts.governanceRouter!.proxy.transferGovernor(
    gov.chain.domain,
    governorAddress,
    non.overrides,
  );
  await tx.wait(gov.chain.confirmations);
  log(gov.test, `${non.chain.name}: governorship transferred`);
}

/**
 * Appints the intended ultimate governor in that domain's Governance Router.
 * If the governor address is not configured, it will remain the signer
 * address.
 * @param gov - The governor chain deploy instance
 */
export async function appointGovernor(gov: CoreDeploy) {
  const domain = gov.chain.domain;
  const governor = await gov.governorOrSigner();
  if (governor) {
    log(
      gov.test,
      `${gov.chain.name}: transferring root governorship to ${domain}:${governor}`,
    );
    const tx = await gov.contracts.governanceRouter!.proxy.transferGovernor(
      domain,
      governor,
      gov.overrides,
    );
    await tx.wait(gov.chain.confirmations);
    log(gov.test, `${gov.chain.name}: root governorship transferred`);
  }
}

/**
 * Deploy the entire suite of Abacus contracts
 * on each chain within the chains array
 * including the upgradable Outbox, Inboxs, and GovernanceRouter
 * that have been deployed, initialized, and configured
 * according to the deployAbacus script
 *
 * @dev The first chain in the array will be the governing chain
 *
 * @param deploys - An array of chain deploys
 */
export async function deployNChains(deploys: CoreDeploy[]) {
  if (deploys.length == 0) {
    throw new Error('Must pass at least one deploy config');
  }

  // there exists any chain marked test
  const isTestDeploy: boolean = deploys.filter((c) => c.test).length > 0;

  log(isTestDeploy, `Beginning ${deploys.length} Chain deploy process`);
  log(isTestDeploy, `Deploy env is ${deploys[0].config.environment}`);
  log(isTestDeploy, `${deploys[0].chain.name} is governing`);
  deploys.forEach((deploy) => {
    log(
      isTestDeploy,
      `Updater for ${deploy.chain.name} Outbox is ${deploy.validator}`,
    );
  });

  const govChain = deploys[0];
  const nonGovChains = deploys.slice(1);

  log(isTestDeploy, 'awaiting provider ready');
  await Promise.all([
    deploys.map(async (deploy) => {
      await deploy.ready();
    }),
  ]);
  log(isTestDeploy, 'done readying');

  await Promise.all(deploys.map(deployAbacus));

  // enroll remotes on every chain
  //
  //    NB: do not use Promise.all for this block. It introduces a race condition
  //    which results in multiple inbox implementations on the outbox chain.
  //
  for (let local of deploys) {
    const remotes = deploys.filter(
      (d) => d.chain.domain !== local.chain.domain,
    );
    for (let remote of remotes) {
      log(
        isTestDeploy,
        `connecting ${remote.chain.name} on ${local.chain.name}`,
      );
      await enrollRemote(local, remote);
      log(
        isTestDeploy,
        `connected ${remote.chain.name} on ${local.chain.name}`,
      );
    }
  }

  // appoint the configured governance account as governor
  if (govChain.governor) {
    log(isTestDeploy, `appoint governor: ${govChain.governor}`);
    await appointGovernor(govChain);
  }

  await Promise.all(
    nonGovChains.map(async (non) => {
      await transferGovernorship(govChain, non);
    }),
  );

  // relinquish control of all chains
  await Promise.all(deploys.map(relinquish));

  // write config outputs
  if (!isTestDeploy) {
    deploys.map((d) => d.writeDeployOutput());
    writeRustConfigs(deploys);
  }

  // checks deploys are correct
  const checker = new CoreInvariantChecker(deploys);
  await checker.checkDeploys();
  checker.expectEmpty();
}

/**
 * Copies the partial configs from the default directory to the specified directory.
 *
 * @param dir - relative path to folder where partial configs will be written
 */
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

/**
 * Outputs the values for chains that have been deployed.
 *
 * @param deploys - The array of chain deploys
 */
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
}

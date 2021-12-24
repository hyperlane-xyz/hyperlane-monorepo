import { checkCallforwarderDeploy } from './checks';
import * as xAppContracts from '@optics-xyz/ts-interface/dist/optics-xapps';
import { toBytes32 } from '../utils';
import fs from 'fs';
import { CallforwarderDeploy } from './CallforwarderDeploy';
import assert from 'assert';

type Deploy = CallforwarderDeploy;

export type CallforwarderDeployOutput = {
  bridgeRouter?: string;
};

/**
 * Deploy and configure a cross-chain token bridge system
 * with one BridgeRouter on each of the provided chains
 * with ownership delegated to Optics governance
 *
 * @param deploys - The list of deploy instances for each chain
 */
export async function deployCallforwarderRouters(deploys: Deploy[]) {
  const isTestDeploy: boolean = deploys.filter((c) => c.test).length > 0;

  

  // deploy BridgeTokens & BridgeRouters
  await Promise.all(
    deploys.map(async (deploy) => {
      await deployCallforwarderRouter(deploy);
    }),
  );

  // after all BridgeRouters have been deployed,
  // enroll peer BridgeRouters with each other
  await Promise.all(
    deploys.map(async (deploy) => {
      await enrollAllCallforwarderRouters(deploy, deploys);
    }),
  );

  // // after all peer BridgeRouters have been co-enrolled,
  // // transfer ownership of BridgeRouters to Governance
  // await Promise.all(CallForwarderProxy__factory
  //   deploys.map(async (deploy) => {
  //     await transferOwnershipToGovernance(deploy);
  //   }),
  // );

  await Promise.all(
    deploys.map(async (local) => {
      const remotes = deploys
        .filter((remote) => remote.chain.domain != local.chain.domain)
        .map((remote) => remote.chain.domain);
      await checkCallforwarderDeploy(local, remotes);
    }),
  );

  if (!isTestDeploy) {
    // output the Bridge deploy information to a subdirectory
    // of the core system deploy config folder
    writeCallforwarderDeployOutput(deploys);
  }
}

/**
 * Deploys the BridgeRouter on the chain of the given deploy and updates
 * the deploy instance with the new contract.
 *
 * @param deploy - The deploy instance
 */
export async function deployCallforwarderRouter(deploy: Deploy) {
  console.log(`deploying ${deploy.chain.name} CallforwarderRouter`);

  const callforwarderFactory = new xAppContracts.CallforwarderRouter__factory(deploy.chain.deployer)

  deploy.contracts.callforwarderRouter = await callforwarderFactory.deploy(deploy.coreContractAddresses.xAppConnectionManager)

  assert(
    (await deploy.contracts.callforwarderRouter!.xAppConnectionManager()) ===
      deploy.coreContractAddresses.xAppConnectionManager,
  );

  console.log(`deployed ${deploy.chain.name} CallforwarderRouter`);

  const callforwarderProxyFactory = new xAppContracts.CallForwarderProxy__factory(deploy.chain.deployer)

  const proxy = await callforwarderProxyFactory.deploy(deploy.contracts.callforwarderRouter!.address, 
    // Token address
    "0xfe4f5145f6e09952a5ba9e956ed0c25e3fa4c7f1",
    // gnosis safe address
    "0x6ea17B65845e214D51bbaC636b7Fa6b66962E25c", 5 )

  console.log(`deployed proxy on ${deploy.chain.domain} at ${proxy.address}`)
}

/**
 * Enroll all other chains' BridgeRouters as remote routers
 * to a single chain's BridgeRouter
 *
 * @param deploy - The deploy instance for the chain on which to enroll routers
 * @param allDeploys - Array of all deploy instances for the Bridge deploy
 */
export async function enrollAllCallforwarderRouters(
  deploy: Deploy,
  allDeploys: Deploy[],
) {
  for (let remoteDeploy of allDeploys) {
    if (deploy.chain.domain != remoteDeploy.chain.domain) {
      await enrollCallforwarderRouter(deploy, remoteDeploy);
    }
  }
}

/**
 * Enroll a single chain's BridgeRouter as remote routers
 * on a single chain's BridgeRouter
 *
 * @param local - The deploy instance for the chain on which to enroll the router
 * @param remote - The deploy instance for the chain to enroll on the local router
 */
export async function enrollCallforwarderRouter(local: Deploy, remote: Deploy) {
  console.log(
    `enrolling ${remote.chain.name} CallforwarderRouter on ${local.chain.name}`,
  );

  let tx = await local.contracts.callforwarderRouter!.enrollRemoteRouter(
    remote.chain.domain,
    toBytes32(remote.contracts.callforwarderRouter!.address),
    local.overrides,
  );

  await tx.wait(local.chain.confirmations);

  console.log(
    `enrolled ${remote.chain.name} CallforwarderRouter on ${local.chain.name}`,
  );
}

/**
 * Outputs the values for bridges that have been deployed.
 *
 * @param deploys - The array of bridge deploys
 */
export function writeCallforwarderDeployOutput(deploys: Deploy[]) {
  console.log(`Have ${deploys.length} Callforwarder router deploys`);
  if (deploys.length == 0) {
    return;
  }

  // ensure bridge directory exists within core deploy config folder
  const root = `${deploys[0].coreDeployPath}/Callforwarder`;
  fs.mkdirSync(root, { recursive: true });

  // create dir for this bridge deploy's outputs
  const dir = `${root}/${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });

  // for each deploy, write contracts and verification inputs to file
  for (const deploy of deploys) {
    const name = deploy.chain.name;

    const contracts = deploy.contracts.toJsonPretty();
    fs.writeFileSync(`${dir}/${name}_contracts.json`, contracts);

    fs.writeFileSync(
      `${dir}/${name}_verification.json`,
      JSON.stringify(deploy.verificationInput, null, 2),
    );
  }
}

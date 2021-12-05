import * as proxyUtils from '../proxyUtils';
import { checkFundraiseDeploy } from './checks';
import * as xAppContracts from '@optics-xyz/ts-interface/dist/optics-xapps';
import { toBytes32 } from '../utils';
import fs from 'fs';
import { FundraiseDeploy } from './FundraiseDeploy';
import assert from 'assert';

type Deploy = FundraiseDeploy;

export type FundraiseDeployOutput = {
  bridgeRouter?: string;
};

/**
 * Deploy and configure a cross-chain token bridge system
 * with one BridgeRouter on each of the provided chains
 * with ownership delegated to Optics governance
 *
 * @param deploys - The list of deploy instances for each chain
 */
export async function deployFundraiseRouters(deploys: Deploy[]) {
  const isTestDeploy: boolean = deploys.filter((c) => c.test).length > 0;

  

  // deploy BridgeTokens & BridgeRouters
  await Promise.all(
    deploys.map(async (deploy) => {
      await deployFundraiseRouter(deploy);
    }),
  );

  // after all BridgeRouters have been deployed,
  // enroll peer BridgeRouters with each other
  await Promise.all(
    deploys.map(async (deploy) => {
      await enrollAllFundraiseRouters(deploy, deploys);
    }),
  );

  // // after all peer BridgeRouters have been co-enrolled,
  // // transfer ownership of BridgeRouters to Governance
  // await Promise.all(
  //   deploys.map(async (deploy) => {
  //     await transferOwnershipToGovernance(deploy);
  //   }),
  // );

  await Promise.all(
    deploys.map(async (local) => {
      const remotes = deploys
        .filter((remote) => remote.chain.domain != local.chain.domain)
        .map((remote) => remote.chain.domain);
      await checkFundraiseDeploy(local, remotes);
    }),
  );

  if (!isTestDeploy) {
    // output the Bridge deploy information to a subdirectory
    // of the core system deploy config folder
    writeFundraiseDeployOutput(deploys);
  }
}

/**
 * Deploys the BridgeRouter on the chain of the given deploy and updates
 * the deploy instance with the new contract.
 *
 * @param deploy - The deploy instance
 */
export async function deployFundraiseRouter(deploy: Deploy) {
  console.log(`deploying ${deploy.chain.name} FundraiseRouter`);

  if (deploy.chain.domain === 3000) {
    const governanceTokenInitData =
    xAppContracts.MintableERC20__factory.createInterface().encodeFunctionData(
      'initialize',
      [
        await deploy.chain.deployer.getAddress()
      ],
    );
    deploy.contracts.governanceToken =
    await proxyUtils.deployProxy<xAppContracts.MintableERC20>(
      'FundraiseGovernanceToken',
      deploy,
      new xAppContracts.MintableERC20__factory(deploy.chain.deployer),
      governanceTokenInitData,
    );
  }

  
  const initData =
    xAppContracts.FundraiseRouter__factory.createInterface().encodeFunctionData(
      'initialize',
      [
        deploy.coreContractAddresses.xAppConnectionManager,
        deploy.bridgeContractAddresses.bridgeRouter.proxy,
        deploy.chain.domain === 3000 ? "0x5503216f0C17C63E7AF99BF8E8F48f869Da26bc7" : "0x0000000000000000000000000000000000000000",
        3000,
        deploy.contracts.governanceToken?.proxy.address || "0x0000000000000000000000000000000000000000"
      ],
    );

  deploy.contracts.fundraiseRouter =
    await proxyUtils.deployProxy<xAppContracts.FundraiseRouter>(
      'FundraiseRouter',
      deploy,
      new xAppContracts.FundraiseRouter__factory(deploy.chain.deployer),
      initData,
    );

  assert(
    (await deploy.contracts.fundraiseRouter!.proxy.xAppConnectionManager()) ===
      deploy.coreContractAddresses.xAppConnectionManager,
  );

  if (deploy.chain.domain === 3000) {
    console.log('Transfer to GovernanceTokenOwnership')
    await deploy.contracts.governanceToken!.proxy.transferOwnership(deploy.contracts.fundraiseRouter.proxy.address, deploy.overrides)
  }

  console.log(`deployed ${deploy.chain.name} FundraiseRouter`);
}

/**
 * Enroll all other chains' BridgeRouters as remote routers
 * to a single chain's BridgeRouter
 *
 * @param deploy - The deploy instance for the chain on which to enroll routers
 * @param allDeploys - Array of all deploy instances for the Bridge deploy
 */
export async function enrollAllFundraiseRouters(
  deploy: Deploy,
  allDeploys: Deploy[],
) {
  for (let remoteDeploy of allDeploys) {
    if (deploy.chain.domain != remoteDeploy.chain.domain) {
      await enrollFundraiseRouter(deploy, remoteDeploy);
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
export async function enrollFundraiseRouter(local: Deploy, remote: Deploy) {
  console.log(
    `enrolling ${remote.chain.name} FundraiseRouter on ${local.chain.name}`,
  );

  let tx = await local.contracts.fundraiseRouter!.proxy.enrollRemoteRouter(
    remote.chain.domain,
    toBytes32(remote.contracts.fundraiseRouter!.proxy.address),
    local.overrides,
  );

  await tx.wait(local.chain.confirmations);

  console.log(
    `enrolled ${remote.chain.name} FundraiseRouter on ${local.chain.name}`,
  );
}

/**
 * Transfer Ownership of a chain's BridgeRouter
 * to its GovernanceRouter
 *
 * @param deploy - The deploy instance for the chain
 */
export async function transferOwnershipToGovernance(deploy: Deploy) {
  console.log(`transfer ownership of ${deploy.chain.name} BridgeRouter`);

  let tx = await deploy.contracts.fundraiseRouter!.proxy.transferOwnership(
    deploy.coreContractAddresses.governance.proxy,
    deploy.overrides,
  );

  await tx.wait(deploy.chain.confirmations);

  console.log(`transferred ownership of ${deploy.chain.name} BridgeRouter`);
}

/**
 * Outputs the values for bridges that have been deployed.
 *
 * @param deploys - The array of bridge deploys
 */
export function writeFundraiseDeployOutput(deploys: Deploy[]) {
  console.log(`Have ${deploys.length} fundraise router deploys`);
  if (deploys.length == 0) {
    return;
  }

  // ensure bridge directory exists within core deploy config folder
  const root = `${deploys[0].coreDeployPath}/fundraise`;
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

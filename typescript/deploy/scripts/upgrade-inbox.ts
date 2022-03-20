import {
  getCoreDeploy,
  getCoreConfig,
  getChainConfigs,
  getCore,
  getGovernance,
  getEnvironment,
  getGovernanceDeploy,
  registerRpcProviders,
  registerGovernorSigner,
} from './utils';
import { ViolationType } from '../src/common';
import { CoreInvariantChecker } from '../src/core';
import { expectCalls, GovernanceCallBatchBuilder } from '../src/core/govern';
import { Call } from '@abacus-network/sdk';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const abacusCore = await getCore(environment);
  const abacusGovernance = await getGovernance(environment);
  registerRpcProviders(abacusCore, chains);
  registerRpcProviders(abacusGovernance, chains);
  await registerGovernorSigner(abacusGovernance, chains);

  const deploy = await getCoreDeploy(environment);
  const governance = await getGovernanceDeploy(environment);
  const config = await getCoreConfig(environment);
  const checker = new CoreInvariantChecker(
    deploy,
    config,
    governance.routerAddresses(),
  );
  await checker.check();
  checker.expectViolations([ViolationType.UpgradeBeacon], [chains.length]);
  const builder = new GovernanceCallBatchBuilder(
    deploy,
    abacusGovernance,
    checker.violations,
  );
  const batch = await builder.build();

  for (const local of deploy.domains) {
    for (const remote of deploy.remotes(local)) {
      const inbox = abacusCore.mustGetInbox(local, remote);
      const transferOwnership =
        await inbox.populateTransaction.transferOwnership(
          abacusGovernance.mustGetContracts(remote).router.address
        );
      batch.push(remote, transferOwnership as Call);
    }
  }

  const txs = await batch.build();
  // For each domain, expect one call to upgrade the contract and then three
  // calls to transfer inbox ownership.
  expectCalls(
    batch,
    deploy.domains,
    new Array(chains.length).fill(chains.length),
  );
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(txs);
  console.log(receipts);
}
main().then(console.log).catch(console.error);

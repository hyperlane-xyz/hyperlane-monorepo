import {
  AbacusCore,
  AbacusGovernance,
  coreAddresses,
  governanceAddresses,
  Call,
} from '@abacus-network/sdk';
import { getCoreConfig, getEnvironment, registerMultiProvider } from './utils';
import { ViolationType } from '../src/check';
import { AbacusCoreChecker } from '../src/core';
import { expectCalls, GovernanceCallBatchBuilder } from '../src/core/govern';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses[environment]);
  const governance = new AbacusGovernance(governanceAddresses[environment]);
  registerMultiProvider(core, environment);
  registerMultiProvider(governance, environment);

  const config = await getCoreConfig(environment);
  const checker = new AbacusCoreChecker(
    core,
    config,
    governance.routerAddresses,
  );
  await checker.check();
  checker.expectViolations(
    [ViolationType.UpgradeBeacon],
    [core.domainNumbers.length],
  );
  const builder = new GovernanceCallBatchBuilder(
    core,
    governance,
    checker.violations,
  );
  const batch = await builder.build();

  for (const local of core.domainNumbers) {
    for (const remote of core.remoteDomainNumbers(local)) {
      const inbox = core.mustGetInbox(local, remote);
      const transferOwnership =
        await inbox.populateTransaction.transferOwnership(
          governance.mustGetContracts(remote).router.address,
        );
      batch.push(remote, transferOwnership as Call);
    }
  }

  const txs = await batch.build();
  // For each domain, expect one call to upgrade the contract and then three
  // calls to transfer inbox ownership.
  expectCalls(
    batch,
    core.domainNumbers,
    new Array(core.domainNumbers.length).fill(core.domainNumbers.length),
  );
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(txs);
  console.log(receipts);
}
main().then(console.log).catch(console.error);

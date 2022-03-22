import { core, governance, Call } from '@abacus-network/sdk';
import { getCoreConfig, getEnvironment, registerMultiProvider } from './utils';
import { ViolationType } from '../src/check';
import { AbacusCoreChecker } from '../src/core';
import { expectCalls, GovernanceCallBatchBuilder } from '../src/core/govern';

async function main() {
  const environment = await getEnvironment();
  const abacusCore = core[environment];
  const abacusGovernance = governance[environment];
  registerMultiProvider(abacusCore, environment);
  registerMultiProvider(abacusGovernance, environment);

  const config = await getCoreConfig(environment);
  const checker = new AbacusCoreChecker(
    abacusCore,
    config,
    abacusGovernance.routerAddresses,
  );
  await checker.check();
  checker.expectViolations(
    [ViolationType.UpgradeBeacon],
    [abacusCore.domainNumbers.length],
  );
  const builder = new GovernanceCallBatchBuilder(
    abacusCore,
    abacusGovernance,
    checker.violations,
  );
  const batch = await builder.build();

  for (const local of abacusCore.domainNumbers) {
    for (const remote of abacusCore.remoteDomainNumbers(local)) {
      const inbox = abacusCore.mustGetInbox(local, remote);
      const transferOwnership =
        await inbox.populateTransaction.transferOwnership(
          abacusGovernance.mustGetContracts(remote).router.address,
        );
      batch.push(remote, transferOwnership as Call);
    }
  }

  const txs = await batch.build();
  // For each domain, expect one call to upgrade the contract and then three
  // calls to transfer inbox ownership.
  expectCalls(
    batch,
    abacusCore.domainNumbers,
    new Array(abacusCore.domainNumbers.length).fill(
      abacusCore.domainNumbers.length,
    ),
  );
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(txs);
  console.log(receipts);
}
main().then(console.log).catch(console.error);

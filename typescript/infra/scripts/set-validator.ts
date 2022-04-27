import { initHardhatMultiProvider } from '@abacus-network/deploy/dist/src/utils';
import { AbacusCore, AbacusGovernance } from '@abacus-network/sdk';
import { ethers } from 'hardhat';
import { AbacusCoreGovernor, CoreViolationType } from '../src/core';
import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const [signer] = await ethers.getSigners();
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const multiProvider = initHardhatMultiProvider(config, signer);
  const core = AbacusCore.fromEnvironment(environment, multiProvider);
  if (environment !== 'test') {
    throw new Error(`No governanace addresses for ${environment} in SDK`);
  }
  const governance = AbacusGovernance.fromEnvironment(
    environment,
    multiProvider,
  );

  const governor = new AbacusCoreGovernor(
    multiProvider,
    core,
    governance,
    config.core,
  );
  await governor.check();
  // Sanity check: for each domain, expect one validator violation.
  governor.expectViolations(
    [CoreViolationType.Validator],
    [core.networks().length],
  );
  // Sanity check: for each domain, expect one call to set the validator.
  governor.expectCalls(
    core.networks(),
    new Array(core.networks().length).fill(1),
  );

  // Change to `batch.execute` in order to run.
  const governorActor = await governance.governor();
  const provider = multiProvider.getDomainConnection(governorActor.network)
    .provider!;
  const receipts = await governor.governance.estimateGas(provider);
  console.log(receipts);
}
main().then(console.log).catch(console.error);

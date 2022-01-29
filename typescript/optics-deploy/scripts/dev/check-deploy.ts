import * as alfajores from '../../config/testnets/alfajores';
import { InvariantViolationCollector } from '../../src/checks';
import { checkCoreDeploys } from '../../src/core/checks';
import { configPath, networks } from './agentConfig';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';

const governorDomain = alfajores.chain.domain;

const coreDeploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.devConfig,
);

async function check() {
  const invariantViolationCollector = new InvariantViolationCollector();
  await checkCoreDeploys(
    coreDeploys,
    governorDomain,
    invariantViolationCollector.handleViolation,
  );

  if (invariantViolationCollector.violations.length > 0) {
    console.error(`Invariant violations were found`);
    console.log(invariantViolationCollector.violations);
  }
}

check().then(console.log).catch(console.error);

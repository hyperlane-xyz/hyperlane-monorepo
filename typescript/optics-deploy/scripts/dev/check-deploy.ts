import * as alfajores from '../../config/testnets/alfajores';
import * as kovan from '../../config/testnets/kovan';
import * as gorli from '../../config/testnets/gorli';
import * as fuji from '../../config/testnets/fuji';
import * as mumbai from '../../config/testnets/mumbai';
import { checkCoreDeploys, InvariantViolationCollector } from '../../src/checks';
import { makeAllConfigs } from '../../src/config';
import { configPath } from './agentConfig';

const governorDomain = alfajores.chain.domain;

async function check() {
  const invariantViolationCollector = new InvariantViolationCollector()
  await checkCoreDeploys(
    configPath,
    await Promise.all([
      makeAllConfigs(alfajores, (_) => _.devConfig),
      makeAllConfigs(kovan, (_) => _.devConfig),
      makeAllConfigs(gorli, (_) => _.devConfig),
      makeAllConfigs(fuji, (_) => _.devConfig),
      makeAllConfigs(mumbai, (_) => _.devConfig),
    ]),
    governorDomain,
    invariantViolationCollector.handleViolation
  );

  if (invariantViolationCollector.violations.length > 0) {
    console.error(`Invariant violations were found`)
    console.log(invariantViolationCollector.violations)
  }
}

check().then(console.log).catch(console.error);

import { Contexts } from '../../config/contexts';
import {
  getKeyFunderConfig,
  runKeyFunderHelmCommand,
} from '../../src/funding/deploy-key-funder';
import { HelmCommand } from '../../src/utils/helm';
import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironmentConfig,
} from '../utils';

async function main() {
  const coreConfig = await getEnvironmentConfig();

  await assertCorrectKubeContext(coreConfig);

  const keyFunderConfig = getKeyFunderConfig(coreConfig);
  const agentConfig = await getContextAgentConfig(coreConfig, Contexts.Abacus);

  await runKeyFunderHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    keyFunderConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);

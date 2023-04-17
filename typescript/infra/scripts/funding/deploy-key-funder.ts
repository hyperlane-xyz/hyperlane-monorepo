import { Contexts } from '../../config/contexts';
import {
  getKeyFunderConfig,
  runKeyFunderHelmCommand,
} from '../../src/funding/deploy-key-funder';
import { HelmCommand } from '../../src/utils/helm';
import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironment,
  getEnvironmentConfig,
} from '../utils';

async function main() {
  const env = await getEnvironment();
  const coreConfig = getEnvironmentConfig(env);

  await assertCorrectKubeContext(coreConfig);

  const keyFunderConfig = getKeyFunderConfig(coreConfig);
  const agentConfig = await getContextAgentConfig(
    coreConfig,
    Contexts.Hyperlane,
  );

  await runKeyFunderHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    keyFunderConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);

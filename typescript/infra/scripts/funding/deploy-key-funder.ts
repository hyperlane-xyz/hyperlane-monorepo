import { Contexts } from '../../config/contexts';
import {
  getKeyFunderConfig,
  runKeyFunderHelmCommand,
} from '../../src/funding/key-funder';
import { HelmCommand } from '../../src/utils/helm';
import { assertCorrectKubeContext, getConfigsBasedOnArgs } from '../utils';

async function main() {
  const { agentConfig, envConfig } = await getConfigsBasedOnArgs();
  if (agentConfig.context != Contexts.Hyperlane)
    throw new Error(
      `Invalid context ${agentConfig.context}, must be ${Contexts.Hyperlane}`,
    );

  await assertCorrectKubeContext(envConfig);

  const keyFunderConfig = getKeyFunderConfig(envConfig);

  await runKeyFunderHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    keyFunderConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);

import { Contexts } from '../../config/contexts.js';
import {
  getKeyFunderConfig,
  runKeyFunderHelmCommand,
} from '../../src/funding/key-funder.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

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

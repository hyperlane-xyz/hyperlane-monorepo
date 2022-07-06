import {
  getRelayerFunderConfig,
  runRelayerFunderHelmCommand,
} from '../../src/funding/deploy-relayer-funder';
import { HelmCommand } from '../../src/utils/helm';
import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironmentConfig,
} from '../utils';

async function main() {
  const coreConfig = await getEnvironmentConfig();

  await assertCorrectKubeContext(coreConfig);

  const relayerFunderConfig = getRelayerFunderConfig(coreConfig);
  const agentConfig = await getContextAgentConfig(coreConfig);

  await runRelayerFunderHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    relayerFunderConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);

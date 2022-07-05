import { runRelayerFunderHelmCommand } from '../../src/funding/deploy-relayer-funder';
import { HelmCommand } from '../../src/utils/helm';
import { assertCorrectKubeContext, getEnvironmentConfig } from '../utils';

async function main() {
  const coreConfig = await getEnvironmentConfig();

  await assertCorrectKubeContext(coreConfig);

  await runRelayerFunderHelmCommand(HelmCommand.InstallOrUpgrade, coreConfig);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);

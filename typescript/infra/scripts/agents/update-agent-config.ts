import { deployEnvToSdkEnv } from '../../src/config/environment';
import { writeAgentConfig } from '../../src/deployment/deploy';
import { Modules, getAddressesPath, getArgs } from '../agent-utils';
import { getEnvironmentConfig } from '../core-utils';

async function main() {
  const { environment } = await getArgs().argv;
  const envConfig = getEnvironmentConfig(environment);
  const env = deployEnvToSdkEnv[environment];

  let multiProvider = await envConfig.getMultiProvider();

  const addressesPath = getAddressesPath(environment, Modules.CORE);

  await writeAgentConfig(addressesPath, multiProvider, env);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Failed to update agent config', e);
    process.exit(1);
  });

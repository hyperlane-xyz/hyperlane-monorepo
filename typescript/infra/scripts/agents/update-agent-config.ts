import { envNameToAgentEnv } from '../../src/config/environment.js';
import { writeAgentConfig } from '../../src/deployment/deploy.js';
import { Modules, getAddressesPath, getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const envConfig = getEnvironmentConfig(environment);
  const env = envNameToAgentEnv[environment];

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
